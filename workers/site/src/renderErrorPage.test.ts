import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./types";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { serverTiming } from "./middleware/serverTiming";
import { renderErrorPage } from "./renderErrorPage";

// The one function behind all three of Django's error templates. It is three
// statements long and carries four wiring decisions that nothing else checks:
// which template, which locale, which path, and which clock reading.
//
// Why this file renders the REAL templates through the REAL Nunjucks
// environment rather than stubbing @givefood/templates: the whole content of
// this module is what it hands buildPageContext() and render(). A stub would
// let the test assert that renderErrorPage passes `templateName` to a mock and
// still tell you nothing about whether an unmatched URL produces a page. The
// module comment's own claim -- "all three Django error templates are rendered
// through this exact same buildPageContext()+render() shape" -- is only
// checkable end to end.
//
// The Django originals were read while writing this file:
// givefood/context_processors.py's context() (what the page context is a port
// of) and givefood/templates/{404,403,500}.html (whose `{% trans %}` strings
// are character-for-character the ones in the .njk ports). Where the port
// diverges from that Python, the test asserts what THIS code does and the
// comment says what Django did -- see "the query string" and "page_translatable"
// below.

const env = {} as unknown as AppEnv["Bindings"];

// index.ts mounts serverTiming first and resolveLanguage sixth, both on "*",
// and renderErrorPage reads a context variable from each (requestStartTime via
// elapsedMs; lang and pathAfterPrefix directly). Mounting the real middleware
// rather than c.set()-ing the variables by hand is deliberate: it is the only
// way a test can notice resolveLanguage changing what it puts in
// `pathAfterPrefix`, which is half of every hreflang URL on the page.
function errorApp(template: string, options: { middleware?: boolean } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (options.middleware !== false) {
    app.use("*", serverTiming);
    app.use("*", resolveLanguage);
  }
  app.all("*", async (c) => c.html(await renderErrorPage(c, template)));
  return app;
}

async function render(url: string, template = "404.njk"): Promise<string> {
  return (await errorApp(template).request(url, {}, env)).text();
}

// Same shape as middleware/serverTiming.test.ts's helper: a fixed sequence of
// performance.now() readings, so "Took Nms" is an exact number rather than a
// regex. Each call consumes one entry, so an implementation that read the clock
// an extra time would shift the answer.
function stubClock(readings: [number, ...number[]]) {
  let i = 0;
  return vi.spyOn(performance, "now").mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? readings[0]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the template name", () => {
  it("renders the real 404 page, not the placeholder string this used to return", async () => {
    // render404.ts records that this file replaced "the bare placeholder string
    // this file used to return". That is the regression to prevent: a 404 that
    // is a naked sentence rather than the site's own page. So assert the parts
    // that only a real render through page.njk can produce -- doctype, <head>,
    // footer -- alongside the 404-specific copy.
    //
    // Every string here is character-for-character the `{% trans %}` msgid in
    // givefood/templates/404.html, so this doubles as the parity check on the
    // ported template's English output.
    const html = await render("https://www.givefood.org.uk/no-such-page/");

    expect(html.startsWith("<!DOCTYPE html>\n<html lang=\"en\" dir=\"ltr\"")).toBe(true);
    expect(html).toContain("<title>404 - Not Found - Give Food</title>");
    expect(html).toContain("<h1>404 - Not Found</h1>");
    expect(html).toContain(
      "<p>Sorry, we can&#39;t find that page. It may have been removed or you might have entered an incorrect URL.</p>",
    );
    expect(html).toContain('<li><a href="/">Homepage</a></li>');
    expect(html).toContain('<li><a href="/needs/">Find what food banks need</a></li>');
    expect(html).toContain('<li>Email <a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a></li>');
    // The base template really was applied, so the visitor gets the site's
    // navigation out of a dead end rather than an orphan page.
    expect(html).toContain('<link rel="stylesheet" href="/static/css/gf.css?v=unknown">');
    expect(html).toContain('<footer class="footer">');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("returns a string for the caller to give a status code to, never a Response", async () => {
    // index.ts calls `c.html(await render404(c), 404)` and `c.html(await
    // render500(c), 500)`: the STATUS lives at the call site, and this function
    // contributes only a body. A well-meaning change that returned a Response
    // from here would have to pick a status, and would silently make one of the
    // two callers wrong. Nothing else in the repo pins the return type, because
    // a Response would also stringify into c.html() without complaining.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.use("*", resolveLanguage);
    let value: unknown;
    app.all("*", async (c) => {
      value = await renderErrorPage(c, "404.njk");
      return c.text("handler decides the status, not renderErrorPage");
    });
    const res = await app.request("https://www.givefood.org.uk/no-such-page/", {}, env);

    expect(typeof value).toBe("string");
    expect(value).not.toBeInstanceOf(Response);
    // renderErrorPage touched neither the status nor the response body.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("handler decides the status, not renderErrorPage");
  });

  it("actually uses the name it is given -- 403 and 500 are not 404 with a different label", async () => {
    // The module's claim is that the three templates differ in name ONLY. That
    // is exactly the arrangement in which a hardcoded "404.njk" -- or a
    // `templateName` argument accidentally dropped during a refactor -- would go
    // unnoticed: render403.ts has no call site anywhere in the app (its own
    // comment explains why), so its output is never seen in production at all.
    //
    // The titles come straight from givefood/templates/{403,500}.html's
    // `{% trans %}` msgids.
    const forbidden = await render("https://www.givefood.org.uk/no-such-page/", "403.njk");
    expect(forbidden).toContain("<title>403 - Forbidden - Give Food</title>");
    expect(forbidden).toContain("<h1>403 - Forbidden</h1>");

    const serverError = await render("https://www.givefood.org.uk/no-such-page/", "500.njk");
    expect(serverError).toContain("<title>500 - Internal Server Error - Give Food</title>");
    expect(serverError).toContain("<h1>500 - Internal Server Error</h1>");

    // 403 and 500 share their body copy in the Django originals and in the
    // ports, so the titles above are the only thing separating them -- which is
    // why they, not the paragraph, are what this test leans on.
    const shared = "<p>Sorry, something has gone wrong there and we can&#39;t serve that page. This error has been logged and we&#39;ll look into it.</p>";
    expect(forbidden).toContain(shared);
    expect(serverError).toContain(shared);
    expect(await render("https://www.givefood.org.uk/no-such-page/", "404.njk")).not.toContain(shared);
  });

  it("rejects on a template that is not in the precompiled map", async () => {
    // Not a hypothetical: templates reach the Worker through
    // scripts/precompile.ts, so a template deleted or renamed at build time is
    // absent at run time with nothing failing until a render asks for it. This
    // function has no fallback of its own, which is the entire reason
    // render500.ts wraps its call in a try/catch and returns a bare
    // "<!doctype html><title>500 ...". render404.ts has NO such catch, so the
    // same failure on the 404 path escapes into app.onError -- checked against
    // this repo's Hono here, by throwing from a notFound handler: the error
    // reaches onError and the visitor gets a 500 where a 404 was meant.
    //
    // The message is nunjucks-slim's own, from PrecompiledLoader.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.use("*", resolveLanguage);
    let caught: unknown;
    app.all("*", async (c) => {
      caught = await renderErrorPage(c, "410.njk").catch((err: unknown) => err);
      return c.text("ok");
    });
    await app.request("https://www.givefood.org.uk/gone/", {}, env);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("template not found: 410.njk");
  });
});

describe("the locale", () => {
  // c.get("lang") is cast to the four-locale union with no check. resolveLanguage
  // only ever writes "en" or a member of PREFIXES, so the cast is sound as long
  // as that middleware is the only writer -- these tests pin both halves of that
  // sentence.

  it("renders Welsh copy, a Welsh <html lang> and Welsh URLs from a /cy/ path", async () => {
    // One request proves the whole locale chain: resolveLanguage reads the
    // prefix, renderErrorPage passes it to BOTH buildPageContext (which sets
    // language_code/language_name) and render() (which loads the catalogue and
    // binds `url` to urlForLocale). A change that passed the locale to one and
    // not the other gives a page that says lang="cy" in English, or an English
    // page whose links all carry /cy/ -- both plausible, both silent.
    const html = await render("https://www.givefood.org.uk/cy/no-such-page/");

    expect(html).toContain('<html lang="cy" dir="ltr" class="txt-dir-ltr">');
    // From packages/templates/src/generated/locales/cy.json.
    expect(html).toContain("<title>404 - Heb ei Ganfod - Give Food</title>");
    expect(html).toContain("<h1>404 - Heb ei Ganfod</h1>");
    expect(html).toContain('<li><a href="/">Hafanddalen</a></li>');
    // urlForLocale prefixes an I18N_SCOPED route name, so the logo links to the
    // Welsh homepage -- Django's `{% url 'index' %}` under i18n_patterns did the
    // same. A visitor who lands on a Welsh 404 stays in Welsh.
    expect(html).toContain('<a href="/cy/" class="logo">');
    // debugcomment.njk, from the same context object.
    expect(html).toContain("🌍 Language Cymraeg\n🌍 Language code cy");
  });

  it("renders Irish and Gaelic too, so the catalogue is chosen per request", async () => {
    // Three non-English locales share one cached Nunjucks Environment (env.ts
    // builds it once per isolate). Only cy would be exercised by a test that
    // stopped at the language above, and a mistake that pinned the catalogue to
    // the first locale an isolate happened to serve is exactly the kind of bug
    // an isolate-scoped cache invites.
    expect(await render("https://www.givefood.org.uk/ga/no-such-page/")).toContain("<h1>404 - Níor aimsíodh</h1>");
    expect(await render("https://www.givefood.org.uk/gd/no-such-page/")).toContain("<h1>404 - Cha deach a lorg</h1>");
  });

  it("does not leak one request's locale into the next render in the same isolate", async () => {
    // env.ts injects `_` and `url` per render() call rather than as Environment
    // globals, precisely so this cannot happen -- and its comment says so. This
    // is the test for that sentence, and it has to run two renders through ONE
    // app to mean anything: on Workers the isolate outlives the request, so a
    // leak would show up as English visitors being served Welsh after any Welsh
    // request, intermittently, depending on which isolate they landed on.
    const app = errorApp("404.njk");
    const welsh = await (await app.request("https://www.givefood.org.uk/cy/no-such-page/", {}, env)).text();
    const english = await (await app.request("https://www.givefood.org.uk/no-such-page/", {}, env)).text();

    expect(welsh).toContain("<h1>404 - Heb ei Ganfod</h1>");
    expect(english).toContain("<h1>404 - Not Found</h1>");
    // Both halves of the leak, separately: the catalogue (no Welsh copy) and
    // the bound url() (no Welsh prefix on the logo or the footer's flag link).
    // The English page does still carry ONE "/cy/" -- the Welsh hreflang
    // alternate, which is correct and locale-independent -- so this cannot be
    // written as a blanket "does not contain /cy/".
    expect(english).not.toContain("Heb ei Ganfod");
    expect(english).not.toContain("Hafanddalen");
    expect(english).toContain('<a href="/" class="logo">');
    expect(english).toContain('<a href="/flag/#https://www.givefood.org.uk/no-such-page/"');
  });

  it("throws for a lang outside the four, because the cast is unchecked", async () => {
    // CURRENT BEHAVIOUR, NOT A RECOMMENDATION. `c.get("lang") as "en"|"cy"|"ga"|
    // "gd"` is an assertion, not a validation: i18n.ts's loadCatalogue indexes
    // LOADERS[locale] and calls the result, so a fifth value produces
    // "LOADERS[locale] is not a function" rather than an English fallback.
    //
    // Unreachable today -- resolveLanguage.ts writes "en" or a member of
    // PREFIXES and nothing else writes `lang` -- so this is pinned as
    // documentation of what the cast is standing on. It matters most on the 500
    // path: render500.ts's catch would swallow this into the bare fallback page,
    // so a middleware that started setting `lang` from Accept-Language would
    // silently take the whole site's error pages down to that one line.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.use("*", async (c, next) => {
      c.set("lang", "de");
      c.set("pathAfterPrefix", "/no-such-page/");
      await next();
    });
    let caught: unknown;
    app.all("*", async (c) => {
      caught = await renderErrorPage(c, "404.njk").catch((err: unknown) => err);
      return c.text("ok");
    });
    await app.request("https://www.givefood.org.uk/de/no-such-page/", {}, env);

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain("LOADERS[locale] is not a function");
  });

  it("falls back to English, silently, when no middleware set lang at all", async () => {
    // A documentation test in the same spirit as serverTiming.test.ts's "NaN"
    // one. render404.ts leans in prose on resolveLanguage being global
    // middleware ("`lang`/`pathAfterPrefix` are already set on `c` regardless of
    // whether a route ever matched"); this is what the alternative looks like.
    // render() defaults its locale parameter to "en" when handed undefined, so
    // the page renders perfectly in English and nothing anywhere reports a
    // problem -- but see the alternates test below for the part that does go
    // missing.
    const app = errorApp("404.njk", { middleware: false });
    const res = await app.request("https://www.givefood.org.uk/cy/no-such-page/", {}, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="en" dir="ltr"');
    expect(html).toContain("<h1>404 - Not Found</h1>");
  });
});

describe("the path", () => {
  it("uses the full request path for canonical and the unprefixed one for the alternates", async () => {
    // TWO DIFFERENT PATH VARIABLES, one line apart in the module, and swapping
    // them is undetectable on an English URL -- where c.req.path and
    // pathAfterPrefix are the same string. A /cy/ URL is the only place the
    // difference shows.
    //
    // Getting it wrong is not cosmetic: buildPageContext builds each alternate
    // as `/<code>` + unprefixedPath, so feeding it the already-prefixed path
    // emits hreflang="cy" href=".../cy/cy/no-such-page/" -- a link to a URL that
    // cannot exist, on every error page in every non-English locale.
    const html = await render("https://www.givefood.org.uk/cy/no-such-page/");

    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/cy/no-such-page/">');
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://www.givefood.org.uk/no-such-page/">');
    expect(html).toContain('<link rel="alternate" hreflang="cy" href="https://www.givefood.org.uk/cy/no-such-page/">');
    expect(html).toContain('<link rel="alternate" hreflang="ga" href="https://www.givefood.org.uk/ga/no-such-page/">');
    expect(html).toContain('<link rel="alternate" hreflang="gd" href="https://www.givefood.org.uk/gd/no-such-page/">');
    expect(html).not.toContain("/cy/cy/");
  });

  it("drops the query string from both canonical_path and flag_path", async () => {
    // A DOCUMENTED DIVERGENCE from Django, pinned so it stays deliberate.
    // givefood/context_processors.py builds `flag_path` as canonical_path plus
    // "?" plus request.META['QUERY_STRING'] when there is one (and appends the
    // same query string to every entry in `languages`). This function never
    // passes buildPageContext's optional `querystring`, so the "Something wrong
    // in this page?" link in the footer reports the path only.
    //
    // The consequence is small but real: a visitor flagging a broken search
    // result reports the page without the search that produced it.
    // routes/wfbn/index.ts is the one call site in the repo that DOES pass
    // querystring, so this is a per-route omission rather than a missing
    // feature.
    const html = await render("https://www.givefood.org.uk/needs/?q=beans&sort=nearest");

    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/needs/">');
    expect(html).toContain('<a href="/flag/#https://www.givefood.org.uk/needs/" rel="nofollow" class="flag">');
    expect(html).not.toContain("q=beans");
  });

  it("escapes the request path it reflects, so an unmatched URL is not an XSS vector", async () => {
    // THE MOST IMPORTANT TEST IN THIS FILE. The 404 page echoes the visitor's
    // own path back into three places in the HTML (canonical link, the flag
    // link's fragment, and every hreflang href), and the path of a 404 is
    // attacker-chosen by definition -- it is the one page where an attacker
    // picks the input. Autoescaping is on in env.ts, and this is what stops
    // that from being reflected script execution on www.givefood.org.uk.
    //
    // The escaping is Nunjucks', not this module's, but the exposure is this
    // module's: a matched route reflects a path the router already validated,
    // whereas this one reflects whatever did not match. A future "improvement"
    // that wrapped canonical_path in a SafeString, or switched the template to
    // `| safe`, would land here.
    const html = await render('https://www.givefood.org.uk/x"><script>alert(1)</script>/');

    expect(html).toContain(
      '<link rel="canonical" href="https://www.givefood.org.uk/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/">',
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('"><script>');
  });

  it("spells the same path two different ways in canonical and in the alternates", async () => {
    // CURRENT BEHAVIOUR, AND SUSPECT. c.req.path is Hono's slice of the raw
    // request line, so it hands back `"` and `<` verbatim; pathAfterPrefix comes
    // from `new URL(c.req.url).pathname` in resolveLanguage, which percent-
    // encodes them. One render therefore advertises the same page under two
    // spellings -- an HTML-escaped raw form in <link rel="canonical"> and a
    // percent-encoded form in every hreflang.
    //
    // Harmless for the ordinary 404 (no real URL on this site contains those
    // characters) and safe either way, since both forms are escaped on the way
    // out. Pinned because it is the kind of inconsistency someone "tidies" by
    // making both sides use c.req.path -- which would ALSO change the alternates
    // on every legitimate page, and is the direction that loses the encoding.
    const html = await render('https://www.givefood.org.uk/x"y/');

    expect(html).toContain('<link rel="canonical" href="https://www.givefood.org.uk/x&quot;y/">');
    expect(html).toContain('<link rel="alternate" hreflang="cy" href="https://www.givefood.org.uk/cy/x%22y/">');
  });
});

describe("page_translatable", () => {
  it("claims every error page is translatable, in every locale", async () => {
    // A DIVERGENCE FROM DJANGO, hardcoded `pageTranslatable: true` where
    // context_processors.py computed it:
    //
    //     page_translatable = "/cy/" == translate_url(path, "cy")[:4]
    //
    // translate_url returns the path UNCHANGED when the URL does not resolve,
    // and a 404's path by definition does not resolve. Verified on this machine
    // with the Django installed here (5.2.6) against a minimal i18n_patterns
    // urlconf -- the real givefood settings module does not import on this
    // machine (its sentry_sdk.init() call rejects `enable_logs`, and
    // django_tasks_db is not installed), so this is the mechanism confirmed in
    // isolation, NOT a run of the site's own configuration:
    //
    //     translate_url("/no-such/", "cy")     -> "/no-such/"     => False
    //     translate_url("/cy/no-such/", "cy")  -> "/cy/no-such/"  => True
    //
    // So Django emitted NO hreflang block on an unprefixed 404 and, on a
    // prefixed one, four alternates that were all the identical unchanged path.
    // The port emits four correctly-prefixed alternates in both cases. Better
    // markup than the original; still a divergence, and the reason a
    // parity-diff of a 404 page against production will not match.
    for (const [url, expected] of [
      ["https://www.givefood.org.uk/no-such-page/", "https://www.givefood.org.uk/cy/no-such-page/"],
      ["https://www.givefood.org.uk/gd/no-such-page/", "https://www.givefood.org.uk/cy/no-such-page/"],
    ] as const) {
      const html = await render(url);
      expect(html.match(/<link rel="alternate"/g), url).toHaveLength(4);
      expect(html, url).toContain(`<link rel="alternate" hreflang="cy" href="${expected}">`);
    }
  });

  it("emits no alternates at all if lang was never set, despite claiming translatable", async () => {
    // The other half of the "no middleware" case. buildPageContext gates its
    // `languages` list on `options.locale` being truthy, NOT on
    // page_translatable, so an undefined lang produces a page that says it is
    // translatable and then offers nothing to translate to. Silent: the page is
    // a valid, complete, English 404.
    //
    // Pinned to make the dependency on index.ts's middleware order visible from
    // this side too. The 404 handler runs for unmatched paths, which is the one
    // situation where "did the middleware run?" is easy to get wrong.
    const html = await (await errorApp("404.njk", { middleware: false }).request("https://www.givefood.org.uk/x/", {}, env)).text();

    expect(html).not.toContain('<link rel="alternate"');
    expect(html).toContain("<h1>404 - Not Found</h1>");
  });

  it("doubles the locale prefix if lang was set but pathAfterPrefix was not", async () => {
    // The failure mode the first test in "the path" is guarding against, shown
    // directly: with `unprefixedPath` absent, buildPageContext falls back to
    // `options.path` -- the already-prefixed one. Reachable two ways: dropping
    // the `unprefixedPath` line from this module, or mounting a sub-app that
    // sets `lang` without resolveLanguage's other variable. Both produce links
    // to /cy/cy/ URLs on every non-English error page, and nothing throws.
    const app = new Hono<AppEnv>();
    app.use("*", serverTiming);
    app.use("*", async (c, next) => {
      c.set("lang", "cy");
      await next();
    });
    app.all("*", async (c) => c.html(await renderErrorPage(c, "404.njk")));
    const html = await (await app.request("https://www.givefood.org.uk/cy/no-such-page/", {}, env)).text();

    expect(html).toContain('<link rel="alternate" hreflang="cy" href="https://www.givefood.org.uk/cy/cy/no-such-page/">');
  });
});

describe("render_time_ms", () => {
  it("reports whole milliseconds measured from the start of the request", async () => {
    // The one context key this module adds on top of buildPageContext's output,
    // and the only one that is not a pure function of the URL. elapsedMs(c)
    // subtracts requestStartTime -- set by serverTiming
    // BEFORE the router ran -- so the number covers the failed route's own work
    // as well as this render. That is what makes a slow 404 or a slow 500
    // diagnosable from the page itself, which for an error page is often the
    // only artefact anybody keeps.
    //
    // 1000 -> 1064.4 is the "Took 64ms" from serverTiming.ts's own comment about
    // dropping Django's three decimal places; if that divergence were ever
    // reverted this would read "Took 64.400ms".
    stubClock([1000, 1064.4]);
    const html = await render("https://www.givefood.org.uk/no-such-page/");

    expect(html).toContain("⏱️ Took 64ms");
  });

  it("renders a complete page saying 'Took NaNms' when serverTiming never ran", async () => {
    // Documentation, not endorsement -- and the exact claim render500.ts's
    // comment makes in prose ("serverTiming ... and resolveLanguage ... are both
    // global middleware that run BEFORE any route handler, so requestStartTime
    // ... [is] already set on `c`"). Without it, `performance.now() -
    // undefined` is NaN, String(NaN) is "NaN", and the page is otherwise
    // perfect. Nothing throws, nothing is logged, and it appears only inside an
    // HTML comment -- so the registration order in index.ts is load-bearing in a
    // way no monitoring would ever surface.
    const html = await (await errorApp("404.njk", { middleware: false }).request("https://www.givefood.org.uk/x/", {}, env)).text();

    expect(html).toContain("⏱️ Took NaNms");
    expect(html).toContain("<h1>404 - Not Found</h1>");
  });

  it("re-reads the clock for each render rather than caching a first answer", async () => {
    // A Worker isolate serves many requests, and the page context here is built
    // fresh on every call. A memoised context -- a tempting "optimisation" for a
    // page whose content is otherwise identical for every visitor -- would pin
    // the first request's timing (and, worse, the first request's path and
    // locale) onto every error page the isolate served afterwards. Two requests
    // through one app, two different numbers.
    // Three readings per request: serverTiming's t0, elapsedMs inside the
    // render, then serverTiming's own end-of-chain read for the header.
    stubClock([1000, 1005, 1005, 2000, 2080, 2080]);
    const app = errorApp("404.njk");
    const first = await (await app.request("https://www.givefood.org.uk/a/", {}, env)).text();
    const second = await (await app.request("https://www.givefood.org.uk/b/", {}, env)).text();

    expect(first).toContain("⏱️ Took 5ms");
    expect(second).toContain("⏱️ Took 80ms");
    expect(first).toContain('<link rel="canonical" href="https://www.givefood.org.uk/a/">');
    expect(second).toContain('<link rel="canonical" href="https://www.givefood.org.uk/b/">');
  });
});

describe("repeatability", () => {
  it("gives byte-identical HTML for the same request twice", async () => {
    // Cloudflare may run this handler for the same URL any number of times, and
    // the 404/500 pages are cached at the edge like anything else. Two renders
    // of one URL must not differ, so nothing here may accumulate state across
    // calls (a context object mutated in place, a `languages` array pushed to
    // rather than rebuilt -- the second would grow four alternates per request).
    //
    // The clock is stubbed flat so "Took 0ms" is stable, and the only remaining
    // moving part is debugcomment.njk's `{{ now() }}`, which reads the wall
    // clock and is blanked out of both strings before comparing.
    stubClock([1000, 1000]);
    const app = errorApp("500.njk");
    const strip = (html: string) => html.replace(/🕰️ Generated at .*\n/, "");

    const first = strip(await (await app.request("https://www.givefood.org.uk/cy/boom/", {}, env)).text());
    const second = strip(await (await app.request("https://www.givefood.org.uk/cy/boom/", {}, env)).text());

    expect(second).toBe(first);
    // The strip actually removed something, or the assertion above is vacuous
    // for the wrong reason.
    expect(first).not.toContain("Generated at");
    expect(first).toContain("<h1>500 - Gwall Gweinydd Mewnol</h1>");
  });
});
