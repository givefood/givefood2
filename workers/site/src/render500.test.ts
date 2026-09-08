import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";
import { render404 } from "./render404";
import { render500 } from "./render500";
import { renderErrorPage } from "./renderErrorPage";
import { resolveLanguage } from "./middleware/resolveLanguage";
import { serverTiming } from "./middleware/serverTiming";
import type { AppEnv } from "./types";
import type { Env } from "../worker-configuration";

// render500() is the page an ALREADY-BROKEN request lands on, which makes it
// the one module in the site worker whose failures nobody sees. Every other
// page announces a regression by looking wrong to a visitor; this one is only
// ever reached after something else has already gone wrong, so a 500 page that
// renders the 404 template, loses the visitor's language, or -- the case its
// own try/catch exists for -- throws a second time, all look identical from
// the outside: "the site errored".
//
// WHAT IS ACTUALLY AT STAKE, and what each block below defends:
//
//   1. IT MUST BE THE REAL PAGE. renderErrorPage() runs the same
//      buildPageContext() + render() pipeline every other page uses, so the
//      500 is a full translated Give Food page with a logo, a canonical URL
//      and a way to contact the charity. index.ts records what was there
//      before WP 4.1: "an uncaught exception previously produced Hono's own
//      bare default error response". Asserting the status alone would pass
//      with that, with this module's own fallback string, with the 404
//      template, and with an English page served to a Welsh visitor.
//
//   2. IT MUST NEVER THROW. The fallback exists for a fault in the SHARED
//      pipeline (a bad locale reaching loadCatalogue, a template missing from
//      the precompiled map after a bad build) rather than in whatever route
//      originally errored. Verified below, not assumed: with the try/catch
//      removed the rejection escapes app.fetch() itself and `app.request()`
//      REJECTS, i.e. past even app.onError, which on Workers means the
//      platform's raw error page instead of any page at all.
//
//   3. IT MUST NOT SAY WHAT WENT WRONG. render500() is handed only the
//      context, never the error, and index.ts logs the exception itself. The
//      tests assert the exception text is absent from both the real page and
//      the fallback, because "helpfully" threading `err` into the template is
//      a one-line change that leaks a stack trace or a D1 error to the public.
//
// REAL EVERYTHING. index.ts's own default export supplies the real router and
// the real middleware order (serverTiming, then resolveLanguage, both of whose
// context vars this module's comment leans on), and the requests below reach
// app.onError the way production does: a route that needs the D1 binding, with
// no D1 binding in the test env. The templates are the real precompiled
// Nunjucks environment and the real compiled .po catalogues, so the Welsh
// assertions are the strings a Welsh visitor actually gets. Nothing is mocked
// except console.error, which is silenced only so a deliberately-broken
// request does not print a stack trace over the test output.
//
// DJANGO PARITY, CHECKED BY RUNNING IT. This module's header comment says
// Django's 500 is "rendered with the request still attached so
// context_processors.py's context() runs same as any other page". That is
// true of Django's 404 handler and NOT of its 500 handler: in the reference
// checkout's own Django (foodcharity/.venv, django-6.1.dist-info)
// django/views/defaults.py's server_error() ends in `template.render()` --
// no context, no request, docstring "Context: None" -- while page_not_found()
// ends in `template.render(context, request)`. Confirmed by executing that
// venv's Django against a two-variable template with a context processor
// registered: `t.render()` produced "[][]" and `t.render({}, request)`
// produced "[FROM_PROCESSOR][cy]". So Django's live 500 page has an empty
// language_code, no canonical URL and no hreflang alternates, and the port's
// is strictly richer. The tests below pin the PORT's behaviour (rule: pin what
// the code does), and say where that is a divergence rather than a port.

// No bindings at all. Every path used here either needs none, or needs the
// missing D1 and therefore throws -- which is the point: reaching
// app.onError through the real chain, rather than calling render500() with a
// hand-built context, is the only way to prove the claim its comment makes
// about `lang`/`pathAfterPrefix`/`requestStartTime` already being set.
const env = {} as unknown as Env;

const ORIGIN = "https://www.givefood.org.uk";

/** A request through the real app, plus the pieces of the rendered page worth asserting. */
async function errorPage(path: string) {
  const res = await app.request(`${ORIGIN}${path}`, {}, env);
  const body = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("Content-Type"),
    contentLanguage: res.headers.get("Content-Language"),
    body,
    htmlTag: body.match(/<html[^>]*>/)?.[0],
    title: body.match(/<title>([^<]*)<\/title>/)?.[1],
    h1: body.match(/<h1>([^<]*)<\/h1>/)?.[1],
    paragraph: body.match(/<p>([^<]*)<\/p>/)?.[1],
    logoHref: body.match(/<a href="([^"]*)" class="logo">/)?.[1],
    canonical: body.match(/<link rel="canonical" href="([^"]*)">/)?.[1],
    flagHref: body.match(/<a href="([^"]*)" rel="nofollow" class="flag">/)?.[1],
    alternates: [...body.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g)].map(
      (m) => [m[1], m[2]] as [string, string],
    ),
  };
}

/**
 * index.ts's app.onError, reproduced exactly (`c.html(await render500(c), 500)`)
 * on a throwaway app, for the cases the real router cannot reach: a stubbed
 * clock, a context that never went through resolveLanguage, and a locale the
 * catalogue loader has no entry for. `middlewares` are mounted in order above a
 * route that always throws.
 */
function appThatFails(...middlewares: MiddlewareHandler<AppEnv>[]) {
  const failing = new Hono<AppEnv>();
  for (const middleware of middlewares) failing.use("*", middleware);
  failing.get("*", () => {
    throw new Error("D1_READ_FAILED_secret_detail");
  });
  failing.onError(async (_err, c) => c.html(await render500(c), 500));
  return failing;
}

/** performance.now() driven from a fixed list, as in middleware/serverTiming.test.ts. */
function stubClock(readings: [number, ...number[]]) {
  let i = 0;
  return vi
    .spyOn(performance, "now")
    .mockImplementation(() => readings[Math.min(i++, readings.length - 1)] ?? readings[0]);
}

// The bare string render500() returns when the real page cannot be rendered.
// Written out in full rather than imported, so a change to it has to be made
// twice, deliberately: this is the last thing a visitor sees before the
// platform's own error page, and it is not covered by any template test.
const FALLBACK = "<!doctype html><title>500 - Internal Server Error</title><h1>500 - Internal Server Error</h1>";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("render500 through index.ts's app.onError, its only caller", () => {
  it("serves the real 500 page, not a placeholder", async () => {
    // /write/to/:slug/ needs the D1 binding the test env does not have, so
    // writeConstituency throws and app.onError renders this. Every assertion
    // is a VALUE from the body: a status-only test passes just as happily
    // when render500 returns its bare fallback, which is exactly the
    // regression this file has to be able to see.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const page = await errorPage("/write/to/sid-valley/");

    expect(page.status).toBe(500);
    expect(page.contentType).toBe("text/html; charset=UTF-8");
    expect(page.title).toBe("500 - Internal Server Error - Give Food");
    expect(page.h1).toBe("500 - Internal Server Error");
    // The apostrophes arrive HTML-escaped: the strings come out of the
    // catalogue as plain text and go through Nunjucks autoescape, same as
    // Django's {% trans %} inside an autoescaping template.
    expect(page.paragraph).toBe(
      "Sorry, something has gone wrong there and we can&#39;t serve that page. This error has been logged and we&#39;ll look into it.",
    );

    // The three ways out of a broken page. 500.njk hardcodes these two hrefs
    // rather than building them with url(), byte-identical to Django's
    // givefood/templates/500.html -- see the Welsh test below for why that
    // asymmetry is deliberately preserved rather than "fixed".
    expect(page.body).toContain('<li><a href="/">Homepage</a></li>');
    expect(page.body).toContain('<li><a href="/needs/">Find what food banks need</a></li>');
    expect(page.body).toContain('<a href="mailto:mail@givefood.org.uk">mail@givefood.org.uk</a>');
  });

  it("renders 500.njk and not one of its two near-identical siblings", async () => {
    // 404.njk, 403.njk and 500.njk are the same file with three strings
    // changed, and renderErrorPage() takes the template name as an argument --
    // so `renderErrorPage(c, "404.njk")` inside render500 is a copy-paste
    // between three near-identical files that produces a valid page with the wrong
    // heading, telling the visitor their URL was wrong when in fact the site
    // broke. Nothing else in the suite would notice.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const page = await errorPage("/write/to/sid-valley/");

    expect(page.body).not.toContain("404 - Not Found");
    expect(page.body).not.toContain("403 - Forbidden");
    // Both sibling templates carry their own paragraph; 500's is the only one
    // that mentions the error having been logged.
    expect(page.body).not.toContain("Sorry, we can&#39;t find that page.");
  });

  it("apologises in the visitor's own language, from the real .po catalogues", async () => {
    // THE FAILURE THIS PREVENTS: a Welsh visitor being told, in English, that
    // something has gone wrong -- on the page least likely to be looked at
    // after a deploy. renderErrorPage reads c.get("lang") and passes it BOTH
    // to buildPageContext (for language_code/language_name) AND as render()'s
    // third argument (which selects the catalogue). Drop the second and the
    // page still renders, still says <html lang="cy">, and is entirely in
    // English; these assertions are the only thing that can tell the
    // difference.
    //
    // The strings are the real compiled catalogue's, not invented: en/cy/ga/gd
    // are the four locales this Worker serves (packages/templates/src/i18n.ts).
    vi.spyOn(console, "error").mockImplementation(() => {});

    const expected = [
      { locale: "cy", h1: "500 - Gwall Gweinydd Mewnol", homepage: "Hafanddalen" },
      { locale: "ga", h1: "500 - Earráid Freastalaí Inmheánach", homepage: "Leathanach baile" },
      { locale: "gd", h1: "500 - Mearachd Frithealaiche a-staigh", homepage: "Duilleag-dhachaigh" },
    ] as const;

    for (const { locale, h1, homepage } of expected) {
      // /needs/at/:slug/ is D1-backed too, and unlike /write/to/ it really is
      // registered under all three prefixes -- so this is a URL a real Welsh
      // visitor can be on when the database goes away.
      const page = await errorPage(`/${locale}/needs/at/sid-valley/`);

      expect(page.status, locale).toBe(500);
      expect(page.h1, locale).toBe(h1);
      expect(page.title, locale).toBe(`${h1} - Give Food`);
      // <html lang> and the Content-Language header have to agree with the
      // body: they come from two different places (page.njk's language_code
      // vs resolveLanguage's post-next() header) and only this file asserts
      // the pair on an error response.
      expect(page.htmlTag, locale).toBe(`<html lang="${locale}" dir="ltr" class="txt-dir-ltr">`);
      expect(page.contentLanguage, locale).toBe(locale);
      // url('index') is locale-bound through render()'s catalogue argument,
      // so the logo goes to the Welsh homepage...
      expect(page.logoHref, locale).toBe(`/${locale}/`);
      // ...while the two body links do NOT, because 500.njk hardcodes "/" and
      // "/needs/" exactly as Django's 500.html does. Pinned as current
      // behaviour and as deliberate parity: a Welsh visitor's "Homepage" link
      // has always dropped them into English. Fixing it would be a divergence
      // from Django, which is a maintainer's decision, not a test's.
      expect(page.body, locale).toContain(`<li><a href="/">${homepage}</a></li>`);
      expect(page.body, locale).toContain('<li><a href="/needs/">');
    }
  });

  it("keeps the URL that actually failed in the canonical and flag links", async () => {
    // buildPageContext is given c.req.path, so the 500 page identifies the
    // page the visitor was on -- which is what makes the footer's "Something
    // wrong in this page?" link worth anything: it carries that path to
    // /flag/ as a fragment, and that report is how a broken page gets
    // noticed at all. A 500 that canonicalised itself to "/" would send
    // every report in with the same useless URL.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const page = await errorPage("/cy/needs/at/sid-valley/?q=beans&x=2");

    // The PREFIXED path, not the unprefixed one: canonical_path is built from
    // c.req.path as it arrived.
    expect(page.canonical).toBe(`${ORIGIN}/cy/needs/at/sid-valley/`);
    expect(page.flagHref).toBe(`/cy/flag/#${ORIGIN}/cy/needs/at/sid-valley/`);

    // THE QUERY STRING IS DROPPED, and that is current behaviour, not an
    // accident of this test's URL. Django's context_processors.py appends
    // request.META['QUERY_STRING'] to flag_path on every page; the port only
    // passes `querystring` from routes/wfbn/index.ts (the one page with a
    // search box), and renderErrorPage never does. So a 500 on a URL whose
    // query is what triggered it reports a flaggable URL without it. Mild,
    // consistent with the rest of the port, and pinned so that a future
    // change to renderErrorPage is a decision rather than a surprise.
    expect(page.canonical).not.toContain("beans");
    expect(page.body).not.toContain("q=beans");
  });

  it("advertises hreflang alternates even for a URL with no translated form", async () => {
    // SUSPECT, PINNED AS-IS. renderErrorPage hardcodes pageTranslatable:true,
    // so every 500 page claims four language versions of itself. Django
    // computed page_translatable per URL (translate_url(path,"cy") starting
    // "/cy/"), and /write/to/ is registered outside i18n_patterns there and
    // outside the LOCALES loop here -- index.ts:166 says so in as many words:
    // "there is no /cy/write/to/... URL to cover". So these three alternates
    // point at URLs that do not exist, as the second half of this test shows.
    //
    // Consequence is small but real: a crawler that follows them gets a 404,
    // on a page that is already a 500. Not fixed here (tests pin behaviour),
    // and reported instead.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const page = await errorPage("/write/to/sid-valley/");

    expect(page.alternates).toEqual([
      ["en", `${ORIGIN}/write/to/sid-valley/`],
      ["cy", `${ORIGIN}/cy/write/to/sid-valley/`],
      ["ga", `${ORIGIN}/ga/write/to/sid-valley/`],
      ["gd", `${ORIGIN}/gd/write/to/sid-valley/`],
    ]);

    // The proof that three of those four are dead: same app, same request
    // shape, no such route.
    const welsh = await app.request(`${ORIGIN}/cy/write/to/sid-valley/`, {}, env);
    expect(welsh.status).toBe(404);
  });

  it("builds the alternates from the unprefixed path, so they cannot double up", async () => {
    // renderErrorPage passes c.get("pathAfterPrefix") as unprefixedPath. Drop
    // it and buildPageContext falls back to options.path -- the path WITH its
    // prefix -- so the Welsh 500 page would advertise
    // /cy/cy/needs/at/sid-valley/. Google follows hreflang alternates, so that
    // is a self-inflicted crawl of nonexistent URLs, from the one page type
    // nobody looks at.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const page = await errorPage("/gd/needs/at/sid-valley/");

    expect(page.alternates).toEqual([
      ["en", `${ORIGIN}/needs/at/sid-valley/`],
      ["cy", `${ORIGIN}/cy/needs/at/sid-valley/`],
      ["ga", `${ORIGIN}/ga/needs/at/sid-valley/`],
      ["gd", `${ORIGIN}/gd/needs/at/sid-valley/`],
    ]);
  });

  it("never puts the exception anywhere in the page, and logs it exactly once", async () => {
    // render500 takes only the context: index.ts's onError logs `err` and
    // then hands render500 nothing but `c`. That separation is the whole
    // reason a Django-style DEBUG=False page cannot leak a stack trace here,
    // and it is one `err` parameter away from being lost.
    //
    // The log count is the other half. Exactly one console.error, carrying
    // the original Error -- not render500's "rendering the real 500 page
    // itself failed" line, which must appear ONLY when the fallback is used.
    // If that line ever showed up here it would mean every 500 on the site
    // was quietly serving the bare page.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const page = await errorPage("/write/to/sid-valley/");

    expect(page.status).toBe(500);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const thrown = consoleError.mock.calls[0]?.[0];
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain("rendering the real 500 page");

    // The real exception's own text, taken from the log rather than guessed,
    // so this keeps working when the underlying D1 failure changes shape.
    const message = (thrown as Error).message;
    expect(message.length).toBeGreaterThan(0);
    expect(page.body).not.toContain(message);
    // And nothing that looks like a stack trace got in by another route.
    expect(page.body).not.toContain("TypeError");
    expect(page.body).not.toContain("    at ");
  });
});

describe("render500 and the context it inherits from a request that already broke", () => {
  it("reports the whole request's elapsed time, not the render's", async () => {
    // renderErrorPage passes elapsedMs(c), which reads requestStartTime --
    // set by serverTiming BEFORE the route that failed ran. So debugcomment's
    // "Took Nms" on a 500 covers the time the failing work actually consumed,
    // which is the number you want when the failure is a timeout. If it were
    // measured from inside render500 it would report ~0ms on every 500 and
    // look entirely plausible.
    //
    // Three clock reads in order: serverTiming's t0, elapsedMs inside the
    // 500 render, serverTiming's post-next() read. 1064.6 - 1000 rounds to
    // the human "65" and formats as the machine "64.600", so this also pins
    // that the two halves of that deliberate divergence still describe the
    // same instant on a failed request.
    stubClock([1000, 1064.6, 1064.6]);

    const res = await appThatFails(serverTiming, resolveLanguage).request(`${ORIGIN}/needs/`, {}, env);
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).toContain("⏱️ Took 65ms");
    expect(res.headers.get("Server-Timing")).toBe("render;dur=64.600");
  });

  it("still renders when the request never reached resolveLanguage", async () => {
    // A DOCUMENTATION TEST, in the same spirit as serverTiming.test.ts's
    // "NaN" one. index.ts mounts serverTiming, securityHeaders, cacheTag,
    // runtimeIdentity and slugRedirect ABOVE resolveLanguage (index.ts:112-117),
    // so an exception from any of them reaches app.onError with `lang` unset.
    // slugRedirect is the one that touches D1 and it swallows its own read
    // failure precisely so it cannot take the page down -- but nothing
    // structural guarantees the next middleware added up there will.
    //
    // What happens then is worth knowing rather than guessing: c.get("lang")
    // is undefined, so render()'s `locale: Locale = "en"` default parameter
    // kicks in and the page renders in English -- while buildPageContext's
    // `options.locale ? ... : []` leaves `languages` EMPTY, so the hreflang
    // block disappears. A Welsh visitor gets an English 500 with no
    // alternates. It does NOT hit the fallback, and it does not throw.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await appThatFails(serverTiming).request(`${ORIGIN}/cy/needs/`, {}, env);
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).toContain("<h1>500 - Internal Server Error</h1>");
    expect(body).toContain('<html lang="en" dir="ltr" class="txt-dir-ltr">');
    expect(body).not.toContain('rel="alternate"');
    // The path still comes through, so the flag link is still useful.
    expect(body).toContain(`<link rel="canonical" href="${ORIGIN}/cy/needs/">`);
    // Nothing logged: render500 only logs from its catch block.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns a string for c.html(), never a Response", async () => {
    // index.ts calls `c.html(await render500(c), 500)`. c.html() accepts a
    // string; hand it a Response and the body becomes "[object Response]"
    // with a 500 status, which reads as "the error page is broken" rather
    // than as a type error anyone would spot in review. Cheap to pin, and
    // the shape both render404.ts and render403.ts share.
    vi.spyOn(console, "error").mockImplementation(() => {});

    let rendered: unknown;
    const failing = new Hono<AppEnv>();
    failing.use("*", serverTiming);
    failing.use("*", resolveLanguage);
    failing.get("*", () => {
      throw new Error("boom");
    });
    failing.onError(async (_err, c) => {
      rendered = await render500(c);
      return c.html(rendered as string, 500);
    });

    const res = await failing.request(`${ORIGIN}/needs/`, {}, env);
    const body = await res.text();

    expect(typeof rendered).toBe("string");
    expect(body).toBe(rendered);
    expect(body.startsWith("<!DOCTYPE html>")).toBe(true);
  });
});

describe("render500 when the shared render pipeline itself fails", () => {
  // HOW THE SECOND FAILURE IS PROVOKED, and why this is not a mock. Setting
  // `lang` to a locale with no catalogue makes packages/templates' loadCatalogue
  // do `LOADERS[locale]()` on an undefined entry -- a real TypeError thrown by
  // real library code inside the real pipeline, which is the class of fault
  // ("a fault in that shared pipeline itself, not just in whatever route
  // originally errored") the try/catch is written for. Today's resolveLanguage
  // cannot produce a locale outside PREFIXES, so this stands in for the faults
  // that need a bad build to reproduce: a template missing from the precompiled
  // map throws "template not found: 500.njk" from the same call and is caught
  // the same way. That equivalence was checked rather than assumed -- renaming
  // 500.njk and re-running the precompile in a copy of the tree outside the repo
  // left this file at 10 failed / 6 passed, the 6 being exactly the tests that
  // expect the fallback (plus the sibling-template one, which a bare fallback
  // satisfies vacuously). A bad locale produces the same split.
  const badLocale: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("lang", "xx");
    c.set("pathAfterPrefix", "/needs/");
    await next();
  };

  it("falls back to the bare page, byte for byte", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await appThatFails(serverTiming, badLocale).request(`${ORIGIN}/needs/`, {}, env);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe(FALLBACK);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  it("resolves instead of rejecting -- which is the entire point of the catch", async () => {
    // THE DIFFERENTIAL. Same broken context, twice: once through render500
    // and once through the unprotected renderErrorPage() call it wraps.
    //
    // The unprotected version does not produce a bad page, it produces NO
    // page: the rejection escapes app.onError and comes back out of
    // app.fetch(), so `app.request()` itself rejects (verified here against
    // hono 4.13.7, the version in workers/site/package.json). On Workers that
    // is the runtime's own "Worker threw exception" response -- no Give Food
    // page, no branding, no way to contact anyone. That is what the four
    // lines of try/catch buy, and it is invisible in a diff.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const unprotected = new Hono<AppEnv>();
    unprotected.use("*", serverTiming);
    unprotected.use("*", badLocale);
    unprotected.get("*", () => {
      throw new Error("D1_READ_FAILED_secret_detail");
    });
    unprotected.onError(async (_err, c) => c.html(await renderErrorPage(c, "500.njk"), 500));

    await expect(unprotected.request(`${ORIGIN}/needs/`, {}, env)).rejects.toThrow(
      "LOADERS[locale] is not a function",
    );

    // The protected form, same inputs, answers.
    const res = await appThatFails(serverTiming, badLocale).request(`${ORIGIN}/needs/`, {}, env);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(FALLBACK);
  });

  it("catches for the 404 handler too, because the chain terminates here", async () => {
    // WHY render500 CARRIES THIS GUARD AND ITS TWO SIBLINGS DO NOT.
    // render404.ts and render403.ts are the same three lines around the same
    // renderErrorPage() call with no try/catch, which reads like an
    // oversight until you follow a 404 through a broken pipeline: Hono
    // catches a throw from app.notFound and hands it to app.onError, which
    // is render500. So render404's second failure lands HERE and is caught
    // HERE, and this function is the only point in the chain where a throw
    // has nowhere left to go. Run, not reasoned: the body below comes from a
    // request that never matched a route at all.
    //
    // Also worth knowing for an outage: during a pipeline fault a
    // nonexistent URL answers 500, not 404, because the notFound handler
    // never gets to set its status.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const failing = new Hono<AppEnv>();
    failing.use("*", serverTiming);
    failing.use("*", badLocale);
    failing.notFound(async (c) => c.html(await render404(c), 404));
    failing.onError(async (_err, c) => c.html(await render500(c), 500));

    const res = await failing.request(`${ORIGIN}/no-such-page/`, {}, env);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe(FALLBACK);
  });

  it("logs the second failure once, with the error, under its own name", async () => {
    // Two failures, two log lines, distinguishable. Without the second line
    // the pipeline fault is completely silent -- the visitor gets a plain
    // 500 page and the logs show only the original route error, so the
    // investigation starts on the wrong module. The message is asserted in
    // full because it is what someone will grep for at 3am.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await appThatFails(serverTiming, badLocale).request(`${ORIGIN}/needs/`, {}, env);

    // Exactly one call here: this app's onError deliberately does NOT log the
    // original error the way index.ts does, so everything recorded is
    // render500's own.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe("render500: rendering the real 500 page itself failed");
    // The error object is passed through, not stringified or swallowed --
    // the stack is the only thing that says WHICH part of the pipeline broke.
    expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(TypeError);
  });

  it("keeps the fallback free of the exception, and free of translation", async () => {
    // The fallback is a literal, so it cannot leak the error and cannot
    // depend on the catalogue that just failed to load -- an English page for
    // a Welsh visitor is the correct trade when the alternative is no page.
    // Asserted rather than assumed, because "let's at least tell them what
    // went wrong" is a plausible-looking edit to a string constant, and this
    // response is served to the public.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await appThatFails(serverTiming, badLocale).request(`${ORIGIN}/cy/needs/`, {}, env);
    const body = await res.text();

    expect(body).not.toContain("D1_READ_FAILED_secret_detail");
    expect(body).not.toContain("LOADERS");
    expect(body).not.toContain("Gwall");
    // Minimal but not malformed: a doctype, a title for the tab, and an h1
    // that says the same thing as the real page's. No stylesheet, no footer,
    // nothing that could itself fail to load.
    expect(body).toBe(FALLBACK);
    expect(body.startsWith("<!doctype html>")).toBe(true);
  });

  it("is reached only on failure -- a working render is never replaced", async () => {
    // The mutant this kills is a swapped try/catch or an over-eager guard
    // that returns the fallback whenever anything looks odd. A 500 page that
    // silently degraded to the bare string for every error would look fine in
    // production (it is, after all, still a 500 page) and would quietly drop
    // the translation, the branding and the contact address from the one page
    // a distressed visitor actually reads.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await appThatFails(serverTiming, resolveLanguage).request(`${ORIGIN}/cy/needs/`, {}, env);
    const body = await res.text();

    expect(body).not.toBe(FALLBACK);
    expect(body).toContain("<h1>500 - Gwall Gweinydd Mewnol</h1>");
  });
});
