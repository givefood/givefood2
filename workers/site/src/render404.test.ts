import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { render404 } from "./render404";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { serverTiming } from "./middleware/serverTiming";
import type { AppEnv } from "./types";

// render404.ts -- the page served for EVERY URL on this site that resolves to
// nothing: a stale link, a closed food bank's slug, a crawler guessing
// /wp-admin/, a typo in a locale prefix. index.ts's app.notFound() is its only
// caller (`c.html(await render404(c), 404)`), and it delegates in one line to
// renderErrorPage(c, "404.njk"), which is where the buildPageContext() +
// render() shape it shares with render403/render500 actually lives.
//
// WHY A ONE-LINE DELEGATION IS WORTH A TEST FILE. Nothing about a 404 is
// checked by anybody: it has no owner, no analytics goal, and every plausible
// breakage still returns 404 with a page that looks fine in a browser. The
// four things that can go wrong here are all invisible from the status code:
//
//   * THE WRONG TEMPLATE. renderErrorPage takes the template name as a string
//     argument, and its three callers differ ONLY in that string. "500.njk"
//     here renders a full, well-formed, correctly-translated page telling
//     every visitor who mistyped a URL that something has gone wrong on our
//     side and has been logged. Status 404, page says 500.
//   * THE WRONG LANGUAGE. The locale comes from c.get("lang"), which
//     resolveLanguage set from the path prefix BEFORE routing -- so a Welsh
//     visitor's dead link is a Welsh 404. Drop the locale argument to render()
//     and /cy/<gone>/ serves English under <html lang="cy">; drop
//     unprefixedPath and every hreflang alternate on the page doubles its
//     prefix (/cy/cy/...), which Google follows and indexes.
//   * REFLECTED INPUT. This is the one page on the site that renders an
//     ATTACKER-CHOSEN path back into HTML -- canonical_path and the footer's
//     flag anchor are both built from c.req.path. If the escaping ever stops,
//     the 404 page is a reflected-XSS endpoint on every URL of the domain at
//     once.
//   * A DATABASE READ. A 404 is what the site answers to junk traffic and
//     vulnerability scanners, i.e. the requests that arrive fastest and in the
//     largest numbers. A query that crept into this path would be paid for at
//     exactly the moment nobody is watching.
//
// REAL EVERYTHING, the same harness as routes/public/contentPages.test.ts and
// index.test.ts: the REAL app (index.ts's default export), so the real router,
// the real global middleware in its real order, and the real app.notFound()
// that is render404's only production caller; the real Nunjucks environment and
// the real compiled .po catalogues, so the Welsh page here is the Welsh page
// that ships. The D1 binding is real in-memory SQLite built from the real
// migrations, and every prepared statement is recorded -- not because this page
// queries (it must not, and that is asserted) but so a query that CREEPS IN
// runs for real and fails on the recorded SQL rather than exploding against a
// stub and hiding inside a 500.
//
// DJANGO PARITY, read rather than assumed. Django registers no handler404
// (there is no such line in givefood/urls.py) and falls back to
// django.views.defaults.page_not_found, which resolves "404.html" by filename
// convention and calls `template.render(context, request)` -- WITH the request,
// so context_processors.py's context() runs exactly as on any other page. Read
// from this machine's own copy: foodcharity/.venv/lib/python3.12/site-packages/
// django/views/defaults.py (Django 6.1, from `.venv/bin/python -c "import
// django; print(django.get_version())"` -- run, not recalled). Its two extra
// context variables, request_path and exception, are referenced by nothing in
// givefood/templates/404.html, so the port dropping them changes no output.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in a
// scratchpad outside the repo -- never by editing a file under src/ and putting
// it back. 23 mutants; 22 failed this file. Widened well past render404.ts,
// because the module is one line and everything that can go wrong with the page
// it renders lives somewhere else. The kills, each one a test's reason to exist:
//
//   render404.ts       "404.njk" -> "500.njk"; "404.njk" -> "403.njk"
//   renderErrorPage.ts locale withheld from render(); locale withheld from
//                      buildPageContext(); unprefixedPath dropped;
//                      unprefixedPath := c.req.path; pageTranslatable := false;
//                      render_time_ms dropped; path := pathAfterPrefix;
//                      querystring passed in
//   index.ts           notFound answers a bare string instead of calling
//                      render404; notFound skips the append-slash probe;
//                      OUT_OF_SCOPE paths answer 501 again
//   middleware         elapsedMs back to toFixed(3); Content-Language dropped;
//                      PREFIXES widened to include "en"; pageCacheControl's
//                      200-only guard removed; cacheTag's 2xx-only guard
//                      removed; slugRedirect forced to read D1 on every request
//   lib/appendSlash.ts the GET/HEAD restriction removed, so POST redirects too
//   packages/templates autoescape := false; translate() ignoring the catalogue
//
// The one that did not fail is not a survivor worth chasing: rendering the page
// BEFORE the append-slash probe and then still returning the redirect changes
// no byte of any response, only the work done to produce it.

const ORIGIN = "https://www.givefood.org.uk";

// middleware/runtimeIdentity.ts turns CF_VERSION_METADATA.id into `version`
// (first 8 characters), which page.njk cache-busts every stylesheet and script
// with. Fixed here so `?v=` is an assertable value rather than the "unknown"
// fallback -- it is the cheapest evidence that the 404 body came through the
// real page.njk chain and not some shortcut.
const VERSION_ID = "abcd1234-0000-4000-8000-000000000000";
const VERSION = "abcd1234";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite, with
// every prepared statement recorded. `prepared` is the point: "the 404 page
// still renders" is true with or without a database read, so the only way to
// pin "this path touches no database" is to look at the statements.
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

// One database for the whole file: nothing here writes to it, and applying
// every migration is the expensive part. `prepared` is what has to be per-test.
beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  prepared = [];
  // Records any subrequest and refuses it loudly. An error page that renders
  // from nothing must not grow a fetch to an analytics endpoint or a
  // suggestion API -- and if one appears, the failure should name it rather
  // than show up as a slow test.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    throw new Error(`unexpected outbound fetch to ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// `async`, not a bare arrow: app.fetch is typed Response | Promise<Response>.
// The ExecutionContext is not optional -- lib/appendSlash.ts reads
// c.executionCtx to re-enter the app for its trailing-slash probe, which is
// the FIRST thing app.notFound() does, so a context built without one turns
// every 404 in this file into a 500.
const get = async (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, { headers, method }), env(), execCtx);

const body = async (path: string, headers: Record<string, string> = {}): Promise<string> => (await get(path, headers)).text();

// includes/debugcomment.njk stamps a wall-clock timestamp and a render duration
// into every page. Both legitimately differ between two responses and neither
// is per-VISITOR, so they are the only things normalised before a byte
// comparison -- and this asserts it found both, so a template change that
// removes them cannot quietly turn the comparison into a comparison of nothing.
function withoutClockNoise(html: string): string {
  expect(html).toMatch(/🕰️ Generated at .+/);
  expect(html).toMatch(/⏱️ Took \d+ms/);
  return html.replace(/🕰️ Generated at .+/, "🕰️ Generated at <T>").replace(/⏱️ Took \d+ms/, "⏱️ Took <N>ms");
}

// The four `<link rel="alternate" hreflang=...>` tags page.njk emits from
// `languages`, in order. Parsed into "code|href" pairs so a failure names the
// language and the URL rather than handing over a slab of markup.
function alternates(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hreflang="([a-z]+)" href="([^"]+)">/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The <li> links inside 404.njk's own body block, as href|text pairs. These are
// the only navigation a visitor who has landed on a dead URL is offered, so
// they are asserted as values rather than counted.
function bodyLinks(html: string): string[] {
  const block = html.slice(html.indexOf("<h1>"), html.indexOf("</ul>"));
  return [...block.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map((m) => `${m[1]}|${m[2]}`);
}

// ---------------------------------------------------------------------------
// The English page
// ---------------------------------------------------------------------------

describe("render404 -- the page behind app.notFound()", () => {
  it("touches no database and makes no subrequest", async () => {
    // 404s are what junk traffic and vulnerability scanners get, i.e. the
    // requests that arrive fastest and in the greatest numbers, so a query on
    // this path is paid for precisely when nobody is looking at a dashboard.
    // The recorded statement list is the only way to see it: a query would not
    // change the rendered page at all.
    //
    // FIRST TEST IN THE FILE, DELIBERATELY. middleware/slugRedirect.ts memoises
    // its map at module scope for five minutes per isolate, and vitest keeps
    // one module registry per file, so ANY earlier request here would warm a
    // memo and hide a query behind it. Proven while mutation-testing: a mutant
    // that made slugRedirect read D1 on every request survived this assertion
    // until the test was moved to the top of the file. Do not reorder.
    //
    // The paths are also outside /needs/at/, which is the one 404 shape that
    // legitimately reads D1 -- slugRedirect looks up the renamed-slug map there
    // before the router ever gets to say "no such food bank".
    for (const path of ["/no-such-page/", "/cy/no-such-page/", "/dashboard/nope/", "/api/2/nope/"]) {
      prepared = [];
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(prepared, path).toEqual([]);
    }
  });

  it("renders the real 404 template through the real page chain", async () => {
    // WHICH TEMPLATE RENDERED, asserted by the strings only 404.njk has.
    // renderErrorPage's three callers differ by one string argument, and
    // "500.njk" or "403.njk" here would produce an equally valid-looking page
    // -- correct <html lang>, correct footer, correct 404 STATUS -- telling a
    // visitor who mistyped a URL that the server is broken. The title and the
    // headline are the whole difference on the wire.
    const res = await get("/no-such-page/");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>404 - Not Found - Give Food</title>");
    expect(html).toContain("<h1>404 - Not Found</h1>");
    // Sibling error pages share the layout and differ only here. Asserting
    // their ABSENCE is what kills the swapped-template mutant in the direction
    // a positive assertion cannot: a page can contain both headlines.
    expect(html).not.toContain("500 - Internal Server Error");
    expect(html).not.toContain("403 - Forbidden");

    // Django's 404.html body copy, character for character apart from the
    // apostrophe's spelling. Both engines escape it -- Django's {% trans %}
    // runs conditional_escape, so the Python side emits `can&#x27;t` where
    // nunjucks emits `can&#39;t` (both run on this machine, not recalled:
    // foodcharity/.venv/bin/python -c "from django.utils.html import escape;
    // print(escape(\"can't\"))"). Same character to every browser, different
    // bytes, and worth writing down because a byte-diff against production
    // Django flags it as a difference on every page of the site.
    expect(html).toContain(
      "<p>Sorry, we can&#39;t find that page. It may have been removed or you might have entered an incorrect URL.</p>",
    );

    // It went through page.njk, not some minimal error shell: the doctype, the
    // language attributes, the versioned stylesheet and the footer are all
    // page.njk's, and a bare-string fallback (which this module's own comment
    // says it USED to return) has none of them.
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en" dir="ltr" class="txt-dir-ltr">');
    expect(html).toContain(`<link rel="stylesheet" href="/static/css/gf.css?v=${VERSION}">`);
    expect(html).toContain("<footer class=\"footer\">");
  });

  it("offers the three links Django's 404.html offers, all of them unprefixed", async () => {
    // The hrefs are HARDCODED in the template ("/" and "/needs/"), not built
    // through url(), which is exactly what givefood/templates/404.html does --
    // so a Welsh visitor's 404 page links to the ENGLISH homepage while the
    // logo above it (which does go through url('index')) links to /cy/. That
    // asymmetry is pinned here and in the locale test below because it looks
    // like an oversight in the port and is not: it is the Django page's own
    // behaviour, and "fixing" it would be a divergence.
    expect(bodyLinks(await body("/no-such-page/"))).toEqual([
      "/|Homepage",
      "/needs/|Find what food banks need",
      "mailto:mail@givefood.org.uk|mail@givefood.org.uk",
    ]);
  });

  it("renders the whole-millisecond render time, not Django's fractional one", async () => {
    // middleware/serverTiming.ts's elapsedMs, reached through renderErrorPage's
    // `render_time_ms`. Django printed "Took 64.066ms"; on Workers the fraction
    // was always exactly ".000" because timers are coarsened against timing
    // attacks, so the port rounds -- a deliberate divergence recorded in that
    // module. If render_time_ms is ever dropped from this context, the line
    // renders as "Took ms" (nunjucks prints an undefined as ""), which this
    // catches; the debug comment is the only place a support request can read
    // it back from.
    const html = await body("/no-such-page/");
    expect(html).toMatch(/⏱️ Took \d+ms/);
    expect(html).not.toMatch(/⏱️ Took [\d.]*\.\d+ms/);
  });

  it("is byte-identical for two different visitors", async () => {
    // This page is served to everyone, has no per-visitor content, and (unlike
    // /flag/, see middleware/pageCacheControl.ts's account of the incident)
    // must never acquire any. Cookies and Accept-Language are the two inputs
    // that have historically leaked into a shared body here: resolveLanguage
    // computes a language from neither, deliberately, and this is the
    // end-to-end statement of that.
    const anonymous = withoutClockNoise(await body("/no-such-page/"));
    const returning = withoutClockNoise(
      await body("/no-such-page/", { Cookie: "csrftoken=abc123; django_language=cy", "Accept-Language": "cy,en;q=0.8" }),
    );
    expect(returning).toBe(anonymous);

    // No token, no cookie: the two things that would make the page
    // per-visitor if a future edit put a form on it.
    const res = await get("/no-such-page/");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).not.toContain("csrfmiddlewaretoken");
  });

  it("carries no Cache-Control and no Cache-Tag", async () => {
    // Both middlewares bail on a non-200 (pageCacheControl "200 only",
    // cacheTag "if (!c.res.ok) return"), so the 404 is left to the zone's own
    // rules. Pinned here rather than assumed because those two middlewares are
    // mounted on "*" and a widening of either would start attaching a shared
    // TTL, or a purgeable tag, to a page whose body echoes the requested URL.
    //
    // The path is chosen so the Cache-Tag half is a real test rather than a
    // vacuous one: cacheTag's FOODBANK_PATH regex matches anything under
    // /needs/at/<slug>, so this response WOULD be stamped `fb-no-such-foodbank`
    // if the non-2xx guard went. It is also deep enough to match no route (and
    // to miss slugRedirect's own /needs/at/<slug>[/<subpage>]/ pattern, which
    // is the one thing on a 404 path that legitimately reads D1).
    const res = await get("/needs/at/no-such-foodbank/a/b/c/");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<h1>404 - Not Found</h1>");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The requested path, reflected back into the page
// ---------------------------------------------------------------------------

describe("render404 -- the requested path in the page", () => {
  it("puts the requested path in the canonical link, not the site root", async () => {
    // renderErrorPage passes `path: c.req.path`, so canonical_path is the URL
    // that 404'd. A mutant using pathAfterPrefix instead is invisible in
    // English and wrong in every other locale (below); a mutant hardcoding "/"
    // would make every 404 on the site claim to be the homepage.
    expect(await body("/no-such-page/")).toContain('<link rel="canonical" href="https://www.givefood.org.uk/no-such-page/">');
  });

  it("drops the query string from the canonical link and the flag anchor", async () => {
    // buildPageContext is called with no `querystring`, so flag_path collapses
    // onto canonical_path and BOTH lose the query. Pinned as current behaviour,
    // and it is a small divergence: Django's context_processors.py:45-47 append
    // request.META['QUERY_STRING'] to flag_path on EVERY page, error pages
    // included, so a "something wrong in this page?" report from a Django 404
    // named ".../search/?q=foodbank" where this one names ".../search/". The
    // report is about a URL that failed, so the query is the interesting half
    // of it. Not changed here -- routes that want the query pass it explicitly,
    // and renderErrorPage serves all three error pages.
    const html = await body("/search/?q=foodbank&page=2");
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/search/">');
    expect(html).toContain('<a href="/flag/#https://www.givefood.org.uk/search/" rel="nofollow" class="flag">');
    expect(html).not.toContain("q=foodbank");
  });

  it("escapes a path full of HTML metacharacters", async () => {
    // THE REFLECTED-XSS TEST. This is the only page on the site that renders an
    // attacker-chosen string into HTML on every URL of the domain at once, and
    // it does it TWICE (the canonical link's href and the footer flag anchor's
    // fragment). Autoescape in packages/templates/src/env.ts is what stands
    // between that and a stored-nowhere, works-everywhere XSS -- and autoescape
    // is one constructor option away from being off, with no other test on this
    // page to notice.
    //
    // PERCENT-ENCODING DOES NOT SAVE THIS. The URL parser encodes <, > and "
    // in a path, so an attacker's markup reaches the Worker as %3Cscript%3E --
    // and then Hono's c.req.path DECODES it again before renderErrorPage ever
    // sees it (measured here, not assumed: the request below is sent fully
    // encoded and the value that arrives at the template is the literal
    // `"><script>alert(1)</script>/x&y='z'/`). Autoescape is therefore the
    // ONLY thing standing between a crafted link and script execution on
    // www.givefood.org.uk, on a page reachable at every URL of the domain.
    const html = await body("/%22%3E%3Cscript%3Ealert(1)%3C/script%3E/x&y='z'/");

    // Every one of the five dangerous characters, entity-encoded, in both
    // places the path is reflected.
    const escaped = "https://www.givefood.org.uk/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/x&amp;y=&#39;z&#39;/";
    expect(html).toContain(`<link rel="canonical" href="${escaped}">`);
    expect(html).toContain(`<a href="/flag/#${escaped}" rel="nofollow" class="flag">`);

    // The whole point: no executable markup anywhere in the document, and no
    // way out of the href attribute either.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain('"><script');
    expect(html).not.toContain("/x&y=");
  });
});

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

describe("render404 -- the language of a dead link", () => {
  // The Welsh/Irish/Gaelic strings as the compiled .po catalogues actually hold
  // them (packages/templates/src/generated/locales/*.json), so a catalogue
  // rebuild that loses an entry fails here rather than silently serving English
  // to a Welsh visitor -- translate() falls back to the msgid, which renders
  // perfectly and says nothing about having failed.
  const TRANSLATIONS = {
    cy: {
      headline: "404 - Heb ei Ganfod",
      apology:
        "Mae&#39;n ddrwg gennym, ni allwn ddod o hyd i&#39;r dudalen honno. Efallai ei bod wedi&#39;i thynnu neu efallai eich bod wedi nodi URL anghywir.",
      homepage: "Hafanddalen",
    },
    ga: {
      headline: "404 - Níor aimsíodh",
      apology:
        "Tá brón orainn, ní féidir linn an leathanach sin a aimsiú. B’fhéidir gur baineadh é nó gur chuir tú URL mícheart isteach.",
      homepage: "Leathanach baile",
    },
    gd: {
      headline: "404 - Cha deach a lorg",
      apology:
        "Duilich, chan urrainn dhuinn an duilleag sin a lorg. Dh’fhaodadh gun deach a thoirt air falbh no dh’fhaodadh gun do chuir thu a-steach URL ceàrr.",
      homepage: "Duilleag-dhachaigh",
    },
  } as const;

  it("renders a prefixed 404 in that prefix's language", async () => {
    // The commonest non-English 404 the site serves, and the one that proves
    // the language is resolved from the PATH before routing rather than from
    // the route that matched -- there is no matched route here at all. A
    // rewrite that resolved the language in the router, or defaulted to "en"
    // when nothing matched (both read as tidier), would serve an English error
    // page at a Welsh URL and pass every 200 test in the suite.
    for (const [locale, expected] of Object.entries(TRANSLATIONS)) {
      const res = await get(`/${locale}/no-such-page/`);
      expect(res.status, locale).toBe(404);
      expect(res.headers.get("Content-Language"), locale).toBe(locale);

      const html = await res.text();
      expect(html, locale).toContain(`<html lang="${locale}" dir="ltr" class="txt-dir-ltr">`);
      expect(html, locale).toContain(`<title>${expected.headline} - Give Food</title>`);
      expect(html, locale).toContain(`<h1>${expected.headline}</h1>`);
      expect(html, locale).toContain(`<p>${expected.apology}</p>`);
      // The English source string must be GONE, not merely accompanied: a
      // render() call that lost its locale argument keeps the layout, the
      // <html lang> and the Content-Language header and changes only this.
      expect(html, locale).not.toContain("404 - Not Found");
      expect(html, locale).toContain(`⏱️ Took`);
      expect(html, locale).toContain(`🌍 Language code ${locale}`);
    }
  });

  it("keeps 404.njk's hardcoded links English even on a translated page", async () => {
    // Django's 404.html hardcodes href="/" and href="/needs/", so the LINK
    // TEXT translates and the DESTINATION does not: a Welsh visitor is offered
    // "Hafanddalen" pointing at the English homepage, while the logo directly
    // above it goes through url('index') and points at /cy/. Faithfully
    // ported, and asserted so that nobody "fixes" one half of it by accident.
    const html = await body("/cy/no-such-page/");
    expect(bodyLinks(html)).toEqual([
      "/|Hafanddalen",
      "/needs/|Dod o hyd i&#39;r hyn sydd ei angen ar fanciau bwyd",
      "mailto:mail@givefood.org.uk|mail@givefood.org.uk",
    ]);
    expect(html).toContain('<a href="/cy/" class="logo">');
    expect(html).toContain('<a href="/cy/flag/#https://www.givefood.org.uk/cy/no-such-page/" rel="nofollow" class="flag">');
  });

  it("builds the hreflang alternates off the UNPREFIXED path", async () => {
    // renderErrorPage passes pageTranslatable: true and
    // unprefixedPath: c.get("pathAfterPrefix"), so a 404 advertises itself in
    // all four languages. The unprefixed path is the load-bearing half: pass
    // c.req.path instead and the Welsh page advertises /cy/cy/no-such-page/,
    // a URL that resolves to a different 404 whose alternates are
    // /cy/cy/cy/... -- an infinitely deep set of dead links, all of them
    // crawlable, generated from one wrong argument.
    //
    // A DIVERGENCE FROM DJANGO, recorded rather than corrected. Django did not
    // pass page_translatable at all: context_processors.py:33 COMPUTES it as
    // `translate_url(path, "cy")[:4] == "/cy/"`, and translate_url returns an
    // unresolvable path unchanged. Run on this machine against the real
    // settings (Django 6.1) rather than reasoned about:
    //   /no-such-page/    -> '/no-such-page/'    translatable: False
    //   /cy/no-such-page/ -> '/cy/no-such-page/' translatable: True
    //   /about-us/        -> '/cy/about-us/'     translatable: True
    // So Django's English 404 carried NO alternates and no language switcher,
    // and its Welsh 404 carried four alternates that were all the SAME URL
    // (translate_url leaves the unresolvable path alone for every language).
    // The port's hardcoded `true` gives every 404 four distinct, prefix-swapped
    // alternates instead -- tidier, and it does tell a crawler about three more
    // URLs that also 404. Pinned as what the code does; changing it is a
    // decision for whoever owns the site's SEO, not for this file.
    expect(alternates(await body("/cy/no-such-page/"))).toEqual([
      "en|https://www.givefood.org.uk/no-such-page/",
      "cy|https://www.givefood.org.uk/cy/no-such-page/",
      "ga|https://www.givefood.org.uk/ga/no-such-page/",
      "gd|https://www.givefood.org.uk/gd/no-such-page/",
    ]);

    // The English 404 gets the same four: `locale` is always passed, so
    // context.ts's `options.locale ? ... : []` branch never produces the empty
    // list here.
    expect(alternates(await body("/no-such-page/"))).toEqual([
      "en|https://www.givefood.org.uk/no-such-page/",
      "cy|https://www.givefood.org.uk/cy/no-such-page/",
      "ga|https://www.givefood.org.uk/ga/no-such-page/",
      "gd|https://www.givefood.org.uk/gd/no-such-page/",
    ]);
  });

  it("treats /en/ and the 17 dropped languages as ordinary unmatched paths", async () => {
    // "en" is never a URL prefix (prefix_default_language=False), and /de/,
    // /pl/, /zh-hans/ are among the 17 Django languages §2.7.1 dropped. All of
    // them therefore reach this page as plain English 404s whose path just
    // happens to start with two letters -- and, because pathAfterPrefix still
    // holds the whole path, the alternates offered are /cy/en/, /ga/en/ and so
    // on. Odd-looking, and correct: those URLs are exactly as absent as the one
    // requested. Pinned so the oddity is a decision rather than a discovery.
    for (const segment of ["en", "de", "zh-hans"]) {
      const res = await get(`/${segment}/`);
      expect(res.status, segment).toBe(404);
      expect(res.headers.get("Content-Language"), segment).toBe("en");
      const html = await res.text();
      expect(html, segment).toContain("<h1>404 - Not Found</h1>");
      expect(html, segment).toContain(`<link rel="canonical" href="https://www.givefood.org.uk/${segment}/">`);
      expect(alternates(html), segment).toContain(`cy|https://www.givefood.org.uk/cy/${segment}/`);
    }
  });
});

// ---------------------------------------------------------------------------
// Which requests actually reach it
// ---------------------------------------------------------------------------

describe("render404 -- what reaches this page and what must not", () => {
  it("does not answer a URL that exists", async () => {
    // The control, and the reason every assertion above is worth anything: a
    // notFound handler that ran for matched routes too would satisfy all of
    // them while taking the site down. /about-us/ is a real page with a real
    // 200 and no 404 markup anywhere in it.
    const res = await get("/about-us/");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("404 - Not Found");
  });

  it("redirects a missing trailing slash instead of rendering the page", async () => {
    // app.notFound() calls tryAppendSlashRedirect FIRST (Django's
    // APPEND_SLASH, a 301) and only renders the 404 if the slashed form does
    // not resolve either. Getting this order wrong would 404 every inbound
    // link on the internet that omits the trailing slash -- which is most of
    // them, since Django has redirected them for years.
    const res = await get("/about-us");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/about-us/`);
    expect(await res.text()).not.toContain("404 - Not Found");

    // And a slashless path whose slashed form ALSO does not exist still lands
    // here, rather than redirecting to a second 404. Note what the canonical
    // says: the URL AS ASKED FOR, with no trailing slash. Reaching this page
    // took TWO renders of it -- app.notFound() ran once for the probe's HEAD
    // /no-such-page/ and once for the real request -- and the visible one must
    // be the second. A shared or reused context here would show "/no-such-page/"
    // and quietly tell every search engine that the dead URL it just crawled
    // canonicalises to a different dead URL.
    const missing = await get("/no-such-page");
    expect(missing.status).toBe(404);
    const html = await missing.text();
    expect(html).toContain("<h1>404 - Not Found</h1>");
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/no-such-page">');
  });

  it("renders the page for a POST to a real path's slashless form", async () => {
    // tryAppendSlashRedirect is restricted to GET/HEAD on purpose (a redirect
    // loses the body, and re-running a mutating request is worse), so a POST
    // that misses the slash gets the 404 page rather than a 301. Django
    // redirects these too -- a recorded, deliberate divergence in
    // lib/appendSlash.ts -- and this is what the divergence looks like on the
    // wire.
    const res = await get("/about-us", {}, "POST");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<h1>404 - Not Found</h1>");
  });

  it("renders the same page for every deliberately out-of-scope URL", async () => {
    // index.ts answers four kinds of "never coming" with c.notFound() rather
    // than a 501: the browse-by-place page, the /dumps subtree, the places
    // sitemaps and the dead firebase service worker. All of them must reach
    // THIS renderer -- notPortedYet.ts's own comment records why 501 was the
    // wrong answer (crawlers read it as "server broken, retry" and keep
    // coming), so a regression that reintroduced a placeholder body here would
    // be a crawl-budget bug, not a cosmetic one.
    // The /cy/ row carries the WELSH headline, because these paths reach the
    // 404 page through the ordinary route table and the language was resolved
    // from the prefix before any of them matched. Written out rather than
    // dropped from the loop: a locale-prefixed out-of-scope URL getting an
    // English page would be a real regression and an easy one to miss.
    const cases: Array<[string, string]> = [
      ["/needs/at/place/devon/exeter/", "404 - Not Found"],
      ["/cy/needs/at/place/devon/exeter/", "404 - Heb ei Ganfod"],
      ["/dumps/", "404 - Not Found"],
      ["/dumps/2026/all.json", "404 - Not Found"],
      ["/sitemap_places.xml", "404 - Not Found"],
      ["/sitemap_places_12.xml", "404 - Not Found"],
      ["/firebase-messaging-sw.js", "404 - Not Found"],
      ["/tests/maplibre/", "404 - Not Found"],
    ];

    for (const [path, headline] of cases) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain(`<h1>${headline}</h1>`);
      expect(html, path).not.toContain("not ported yet");
      expect(html, path).toContain(`<link rel="canonical" href="https://www.givefood.org.uk${path}">`);
    }
  });

  it("renders the page under /api/ too, where a 501 catch-all used to sit", async () => {
    // index.ts deleted its /api catch-all on 2026-09-05 ("NOTHING IS 501 ANY
    // MORE"), so an invalid API path now gets the HTML 404 page like anything
    // else. Worth pinning both halves: that it is a 404 rather than a 501, and
    // that an API client asking for a nonexistent endpoint gets text/html --
    // which is the honest answer here (Django's own 404 for these paths was
    // the same HTML page) and would otherwise look like a bug to whoever finds
    // it in a log.
    const res = await get("/api/2/nope/");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await res.text()).toContain("<h1>404 - Not Found</h1>");
  });
});

// ---------------------------------------------------------------------------
// Called directly, with the context vars its comment relies on
// ---------------------------------------------------------------------------

// A three-line Hono app used ONLY to obtain a real Context to hand to
// render404 -- it is not a stand-in for index.ts's router (every routing claim
// in this file goes through the real app above). It exists because the two
// context variables render404 depends on, `lang` and `requestStartTime`, are
// set by global middleware in production and so can never DISAGREE with the
// URL there; the mutant that reads the locale out of c.req.path instead of
// c.get("lang") is therefore invisible to every test that goes through the
// real chain, and visible here in one line.
async function callRender404(
  path: string,
  vars: { lang?: string; pathAfterPrefix?: string; requestStartTime?: number },
): Promise<{ html?: string; error?: Error }> {
  const harness = new Hono<AppEnv>();
  let outcome: { html?: string; error?: Error } = {};
  harness.all("*", async (c) => {
    if (vars.lang !== undefined) c.set("lang", vars.lang);
    if (vars.pathAfterPrefix !== undefined) c.set("pathAfterPrefix", vars.pathAfterPrefix);
    if (vars.requestStartTime !== undefined) c.set("requestStartTime", vars.requestStartTime);
    try {
      outcome = { html: await render404(c) };
    } catch (error) {
      outcome = { error: error as Error };
    }
    return c.body(null, 204);
  });
  await harness.fetch(new Request(`${ORIGIN}${path}`), env(), execCtx);
  return outcome;
}

describe("render404 -- called directly", () => {
  it("takes the language from the context var, never from the URL", async () => {
    // lang="cy" on an UNPREFIXED path. In production these always agree
    // (resolveLanguage derives one from the other), which is exactly why this
    // has to be asserted here: a version of renderErrorPage that sniffed the
    // locale off c.req.path would be correct for every real request and would
    // quietly stop being correct the moment language resolution changed --
    // and resolveLanguage.ts is a file with a long history of changing.
    const { html } = await callRender404("/no-such-page/", {
      lang: "cy",
      pathAfterPrefix: "/no-such-page/",
      requestStartTime: performance.now(),
    });
    expect(html).toContain("<h1>404 - Heb ei Ganfod</h1>");
    expect(html).toContain('<html lang="cy" dir="ltr" class="txt-dir-ltr">');
    // The canonical still comes from the request path, unprefixed -- proving
    // the two really are independent inputs rather than one derived from the
    // other.
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/no-such-page/">');
  });

  it("takes the alternates' path from pathAfterPrefix, never from the URL", async () => {
    // The other half of the same independence, and the one that produces the
    // /cy/cy/ mutant. Given a request path of "/cy/gone/" and a pathAfterPrefix
    // of "/gone/", the alternates must be built from the latter.
    const { html } = await callRender404("/cy/gone/", {
      lang: "cy",
      pathAfterPrefix: "/gone/",
      requestStartTime: performance.now(),
    });
    expect(alternates(html ?? "")).toEqual([
      "en|https://www.givefood.org.uk/gone/",
      "cy|https://www.givefood.org.uk/cy/gone/",
      "ga|https://www.givefood.org.uk/ga/gone/",
      "gd|https://www.givefood.org.uk/gd/gone/",
    ]);
    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/gone/">');
  });

  it("falls back to English, and to no alternates at all, if resolveLanguage has not run", async () => {
    // CURRENT BEHAVIOUR, NOT DESIRED BEHAVIOUR, and softer than it looks like
    // it should be. renderErrorPage casts an unset `lang` straight to a Locale,
    // so `undefined` reaches both buildPageContext and render() -- where it
    // lands on render()'s `locale: Locale = "en"` DEFAULT PARAMETER (a default
    // fires for an explicitly-passed undefined) and quietly renders English.
    // buildPageContext is the one that notices: its `options.locale ? ... : []`
    // branch yields an empty `languages`, so the page comes out with no
    // hreflang alternates and no language switcher.
    //
    // Unreachable in production -- resolveLanguage is mounted on "*", so `lang`
    // is set before any handler and before app.notFound(), which is precisely
    // the claim render404.ts's own comment makes. It is pinned because the
    // failure mode is SILENT: anyone wiring a second caller (a sub-app with its
    // own notFound, a Durable Object) gets a page that looks entirely correct
    // to a human and has lost every alternate-language URL on it. There is no
    // throw to notice.
    const { error, html } = await callRender404("/cy/no-such-page/", {
      pathAfterPrefix: "/no-such-page/",
      requestStartTime: performance.now(),
    });
    expect(error).toBeUndefined();
    expect(html).toContain("<h1>404 - Not Found</h1>");
    expect(html).toContain('<html lang="en" dir="ltr" class="txt-dir-ltr">');
    expect(alternates(html ?? "")).toEqual([]);
  });

  it("renders 'Took NaNms' if serverTiming has not run", async () => {
    // Same shape, the other global middleware, and a softer failure: elapsedMs
    // subtracts an undefined requestStartTime, so Math.round(NaN) reaches the
    // debug comment as the string "NaN". Also unreachable in production
    // (serverTiming is index.ts's first mount) and also pinned rather than
    // fixed -- it is the visible symptom of a missing middleware, and someone
    // reading "Took NaNms" in a page source should be able to find this test
    // and learn what it means.
    const { html } = await callRender404("/no-such-page/", { lang: "en", pathAfterPrefix: "/no-such-page/" });
    expect(html).toContain("⏱️ Took NaNms");
  });

  it("agrees byte for byte with the page the real app serves", async () => {
    // The join between the two halves of this file: given the context the real
    // middleware chain builds, a direct call produces the same document the
    // site does. If this ever diverges, one of the two is testing something
    // that is not the shipped page.
    const harnessed = await callRender404("/cy/no-such-page/", {
      lang: "cy",
      pathAfterPrefix: "/no-such-page/",
      requestStartTime: performance.now(),
    });
    const served = await body("/cy/no-such-page/");
    expect(withoutClockNoise(harnessed.html ?? "")).toBe(withoutClockNoise(served));
  });

  it("is the same function the real global middleware feeds", async () => {
    // The harness above sets the context vars by hand; this one mounts the
    // REAL serverTiming and resolveLanguage in front of it and sets nothing,
    // which is the arrangement index.ts actually has. Both must produce the
    // Welsh page -- the first proves render404 reads the vars, this proves the
    // real middleware writes the ones it reads, and the pair is what makes
    // "resolveLanguage is global middleware, so lang is already set" (this
    // module's own comment) a checked statement rather than a claim.
    const harness = new Hono<AppEnv>();
    harness.use("*", serverTiming);
    harness.use("*", resolveLanguage);
    harness.all("*", async (c) => c.html(await render404(c), 404));

    const res = await harness.fetch(new Request(`${ORIGIN}/cy/no-such-page/`), env(), execCtx);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<h1>404 - Heb ei Ganfod</h1>");
    expect(html).toMatch(/⏱️ Took \d+ms/);
  });
});
