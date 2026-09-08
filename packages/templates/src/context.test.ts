import { describe, expect, it, vi } from "vitest";
import { buildPageContext, setRuntimeIdentity } from "./context";
import type { Locale, PageContext } from "./index";
import { render } from "./env";

// The port of givefood/context_processors.py's context() -- the dozen-odd
// variables every rendered page reads, built at ~60 call sites and spread
// into every render() call in the Worker.
//
// Why this module is worth a suite of its own even though ~90 route tests
// already render pages that use it: those tests each check ONE page. What is
// only visible from here is the contract itself -- that `canonical_path` is
// the domain plus the path and not the translated path, that omitting
// `locale` yields no alternates at all, that `unprefixedPath` defaults to
// something that is wrong for every prefixed page, and that the field names
// are snake_case because nunjucks reads them by name. Every one of those
// fails SILENTLY: nunjucks is configured with throwOnUndefined: false
// (env.ts:49, matching Django's "missing variable renders as empty"), so a
// renamed or dropped key blanks a line rather than raising anything.
//
// The Django original was read while writing this, not summarised from the
// port's own comments: givefood/context_processors.py in
// /Users/jasoncartwright/Sites/foodcharity. Where the port diverges from it,
// the test asserts what THIS code does and the comment says what Django did.
// Two parity claims below were checked by RUNNING things rather than by
// reasoning, and are marked where they appear:
//   * the four language names and their direction, against Django 5.2.6's
//     own django.conf.locale.LANG_INFO on this machine;
//   * that no URL pattern in givefood/urls.py is gettext-wrapped, which is
//     what makes Django's translate_url(path, current_language) an identity
//     and therefore makes `SITE_DOMAIN + path` a faithful canonical_path.

// givefood/const/general.py:149. Repeated here rather than imported because
// the constant is deliberately NOT exported from context.ts -- a test that
// imported it could not notice it changing.
const DOMAIN = "https://www.givefood.org.uk";

/**
 * A context built by a module that has never had setRuntimeIdentity() called
 * on it. `runtimeIdentity` is a module-scope `let` with a setter and no
 * reset, so a fresh module registry is the only way back to the pre-request
 * state -- the same trick, for the same reason, as
 * workers/site/src/middleware/runtimeIdentity.test.ts's bootIsolate().
 */
async function contextFromVirginModule(options: Parameters<typeof buildPageContext>[0]): Promise<PageContext> {
  vi.resetModules();
  const { buildPageContext: fresh } = await import("./context");
  return fresh(options);
}

// ---------------------------------------------------------------------------
// canonical_path, domain -- context_processors.py:19
// ---------------------------------------------------------------------------

describe("buildPageContext: canonical_path and domain", () => {
  it("is SITE_DOMAIN followed by the path, with nothing inserted between them", () => {
    // Django: canonical_path = "%s%s" % (SITE_DOMAIN, translate_url(path,
    // language_code)). translate_url() re-resolves the path and reverses it in
    // the target language, which only ever swaps the /<lang> prefix UNLESS a
    // URL pattern itself is translated -- and none in givefood/urls.py is
    // (nothing there imports gettext; checked, not assumed). Reversing into
    // the language the path already carries is therefore the identity
    // function, so `SITE_DOMAIN + path` is the faithful port and not a
    // shortcut.
    //
    // This lands in <link rel="canonical"> on every page (page.njk:14). Get it
    // wrong and Google is told a set of pages are duplicates of the wrong URL,
    // which is invisible on the page itself.
    const ctx = buildPageContext({ path: "/needs/" });
    expect(ctx.canonical_path).toBe("https://www.givefood.org.uk/needs/");
    expect(ctx.domain).toBe(DOMAIN);

    // A prefixed page canonicalises to its OWN prefixed URL -- /cy/needs/ is
    // not a duplicate of /needs/, it is the Welsh page, and page.njk emits
    // hreflang alternates precisely so search engines can pair them up.
    expect(buildPageContext({ path: "/cy/needs/", locale: "cy", unprefixedPath: "/needs/" }).canonical_path).toBe(
      "https://www.givefood.org.uk/cy/needs/",
    );
  });

  it("takes the path verbatim -- no encoding, no case folding, no trailing-slash tidying", () => {
    // Every call site passes Hono's c.req.path, which is already the
    // percent-DECODED pathname. Nothing here re-encodes it, so a food bank
    // whose name carries a space or a circumflex canonicalises to a URL with
    // those characters literally in it. Pinned rather than argued about: the
    // escaping that matters happens at render time (env.ts sets
    // autoescape: true), and a "helpful" encodeURI() here would make
    // canonical_path disagree with the URL the crawler actually fetched.
    expect(buildPageContext({ path: "/needs/at/Ynys Môn/" }).canonical_path).toBe(`${DOMAIN}/needs/at/Ynys Môn/`);
    expect(buildPageContext({ path: "/NEEDS/" }).canonical_path).toBe(`${DOMAIN}/NEEDS/`);
    // No slash is added to a slashless path and none is removed from a
    // doubled one: the string that came in is the string that goes out.
    expect(buildPageContext({ path: "/needs" }).canonical_path).toBe(`${DOMAIN}/needs`);
    expect(buildPageContext({ path: "//needs//" }).canonical_path).toBe(`${DOMAIN}//needs//`);
    // The empty path (nothing in this Worker produces it, but renderErrorPage
    // and the scripts build contexts by hand) collapses to the bare domain
    // rather than to a root slash.
    expect(buildPageContext({ path: "" }).canonical_path).toBe(DOMAIN);
  });
});

// ---------------------------------------------------------------------------
// flag_path -- context_processors.py:41-44
// ---------------------------------------------------------------------------

describe("buildPageContext: flag_path", () => {
  it("appends the query string to the canonical URL after a '?'", () => {
    // page.njk:55 renders `<a href="{{ url('flag') }}#{{ flag_path }}">` --
    // the "Something wrong in this page?" link, whose whole job is to tell the
    // maintainer WHICH page was wrong. On /needs/ the query string is the only
    // thing distinguishing one search from another, so dropping it here turns
    // every report from that page into "something is wrong with /needs/".
    // wfbn/index.ts:141 is the one call site in the Worker that passes it.
    const ctx = buildPageContext({ path: "/needs/", querystring: "address=SW1A+1AA&lat=51.50354" });
    expect(ctx.flag_path).toBe(`${DOMAIN}/needs/?address=SW1A+1AA&lat=51.50354`);
    // ...and canonical_path is NOT given the query string, which is the point
    // of them being two fields: /needs/?address=X must canonicalise to /needs/.
    expect(ctx.canonical_path).toBe(`${DOMAIN}/needs/`);
  });

  it("collapses to canonical_path for a missing OR empty query string", () => {
    // Both cases are real and reach here by different routes: most call sites
    // omit the option entirely, while wfbn/index.ts passes
    // `new URL(c.req.url).search.slice(1)`, which is "" for a URL with no "?".
    // The truthiness check is what stops a bare "?" being glued onto the end
    // of every unfiltered /needs/ URL.
    expect(buildPageContext({ path: "/needs/" }).flag_path).toBe(`${DOMAIN}/needs/`);
    expect(buildPageContext({ path: "/needs/", querystring: "" }).flag_path).toBe(`${DOMAIN}/needs/`);
    expect(buildPageContext({ path: "/needs/", querystring: undefined }).flag_path).toBe(`${DOMAIN}/needs/`);
  });

  it("neither strips a leading '?' nor re-encodes what it is given", () => {
    // The caller's contract is `search.slice(1)` -- the query string WITHOUT
    // its "?". Pinned from the wrong side as well as the right one, because
    // the failure is silent: a call site that passed `.search` instead would
    // produce "??address=..." and the flag link would still look plausible.
    expect(buildPageContext({ path: "/needs/", querystring: "?address=SW1A+1AA" }).flag_path).toBe(
      `${DOMAIN}/needs/??address=SW1A+1AA`,
    );
    // Nothing is escaped on the way through either. That is correct rather
    // than lax -- page.njk interpolates flag_path with autoescape on, so
    // escaping here would double-encode it -- but it does mean the raw value
    // is exactly what the request carried.
    expect(buildPageContext({ path: "/needs/", querystring: "q=a b&x=<script>" }).flag_path).toBe(
      `${DOMAIN}/needs/?q=a b&x=<script>`,
    );
  });

  it("keeps the query string OUT of the language alternates, where Django put it in", () => {
    // A deliberate, documented divergence. context_processors.py:36-40 appends
    // request.META['QUERY_STRING'] to every entry in `languages` as well as to
    // flag_path, so switching language on a /needs/ search in Django kept the
    // search. Here the alternates are built from unprefixedPath alone, so the
    // language switcher on a search results page drops back to the unfiltered
    // page.
    //
    // Asserted from both sides in one test so the two cannot quietly converge:
    // the query string IS in flag_path and IS NOT in any language URL.
    const ctx = buildPageContext({
      path: "/needs/",
      querystring: "address=SW1A+1AA",
      locale: "en",
      unprefixedPath: "/needs/",
    });
    expect(ctx.flag_path).toContain("?address=SW1A+1AA");
    expect(ctx.languages.map((l) => l.url)).toEqual(["/needs/", "/cy/needs/", "/ga/needs/", "/gd/needs/"]);
  });
});

// ---------------------------------------------------------------------------
// languages -- context_processors.py:31-40, and PLAN.md §2.7.1's 4 languages
// ---------------------------------------------------------------------------

describe("buildPageContext: the languages list", () => {
  it("is empty when no locale is given, so a non-i18n route offers no alternates", () => {
    // The API docs pages and the write routes call buildPageContext({ path })
    // with nothing else (routes/apiDocs.ts:14, routes/write/index.ts:47).
    // Those URLs are not inside i18n_patterns, so /cy/api/ does not exist --
    // advertising it as an hreflang alternate would point search engines and
    // the language switcher at a 404.
    const ctx = buildPageContext({ path: "/api/1/" });
    expect(ctx.languages).toEqual([]);
    // ...while the page still declares a language for itself. The debug
    // comment prints "Language English" on these pages, and <html lang> needs
    // a value regardless of whether the page can be switched.
    expect(ctx.language_code).toBe("en");
    expect(ctx.language_name).toBe("English");
  });

  it("lists all four languages, with the values Django's get_language_info returns", () => {
    // The names are checked against Django, not transcribed from a comment:
    // running `python3 -c "from django.conf.locale import LANG_INFO"` in
    // /Users/jasoncartwright/Sites/foodcharity (Django 5.2.6, the version
    // actually installed on this machine) prints name_local 'English',
    // 'Cymraeg', 'Gaeilge' and 'Gàidhlig' for en/cy/ga/gd -- which is exactly
    // what context_processors.py:34 put in `language_name`, and what
    // settings.py's LANGUAGES list carries for these four entries.
    //
    // Whole-array equality rather than four spot checks, because the shape of
    // each entry is a contract with two templates that read it by key:
    // langswitcher.njk uses .code, .name and .url, page.njk:25 uses .code and
    // .url.
    const ctx = buildPageContext({ path: "/needs/", locale: "en", unprefixedPath: "/needs/" });
    expect(ctx.languages).toEqual([
      { code: "en", name: "English", url: "/needs/" },
      { code: "cy", name: "Cymraeg", url: "/cy/needs/" },
      { code: "ga", name: "Gaeilge", url: "/ga/needs/" },
      { code: "gd", name: "Gàidhlig", url: "/gd/needs/" },
    ]);
  });

  it("orders them en, cy, ga, gd -- Django had gd before ga", () => {
    // Two things pinned at once. The ORDER is the iteration order of
    // LANGUAGE_NAMES's keys, and it is what the language dropdown renders in;
    // Django iterated settings.py's LANGUAGES (lines 233-255), whose four
    // surviving entries appear as en, cy, gd, ga. A cosmetic divergence, noted
    // rather than corrected, and pinned so that a reordering is a decision
    // rather than an accident of someone alphabetising the object literal.
    //
    // The COUNT is the other half: §2.7.1 dropped 17 of Django's 21 languages.
    // A fifth appearing here would mean a catalogue was added to i18n.ts
    // without the routing (slugRedirect's regex, resolveLanguage's PREFIXES)
    // that makes its URLs resolve.
    const codes = buildPageContext({ path: "/", locale: "en", unprefixedPath: "/" }).languages.map((l) => l.code);
    expect(codes).toEqual(["en", "cy", "ga", "gd"]);
  });

  it("gives English no prefix and everything else one, matching prefix_default_language=False", () => {
    // Django's i18n_patterns runs with prefix_default_language=False, so the
    // English URL is the bare path and /en/ does not exist at all (it 404s in
    // production, and resolveLanguage.ts's PREFIXES deliberately excludes
    // "en"). An alternates list that emitted "/en/needs/" would advertise a
    // 404 to every search engine that read the page.
    const urls = buildPageContext({ path: "/cy/needs/", locale: "cy", unprefixedPath: "/needs/" }).languages;
    expect(urls.find((l) => l.code === "en")?.url).toBe("/needs/");
    expect(urls.map((l) => l.url).some((u) => u.startsWith("/en/"))).toBe(false);
  });

  it("does not depend on which language the page is currently in", () => {
    // The same four alternates on every translation of a page, including a
    // self-referential entry for the current language. That self-entry is not
    // redundant: langswitcher.njk finds the CURRENT language's display name by
    // looping the list and matching `language.code == language_code`, so
    // filtering the current locale out of the list would empty the dropdown's
    // own button label.
    const locales: Locale[] = ["en", "cy", "ga", "gd"];
    const lists = locales.map((locale) =>
      buildPageContext({ path: locale === "en" ? "/needs/" : `/${locale}/needs/`, locale, unprefixedPath: "/needs/" }).languages,
    );
    for (const list of lists) expect(list).toEqual(lists[0]);
    expect(lists[0]?.map((l) => l.code)).toContain("gd");
  });

  it("builds a fresh array every call, so one page's alternates cannot leak onto another", () => {
    // A Worker isolate serves many requests through this one module. The array
    // and its entries are constructed per call today; the regression this
    // guards is an "optimisation" that memoised the list at module scope,
    // which would be invisible on any single page and would then serve the
    // first-rendered page's URLs as the hreflang alternates of every later
    // page in the isolate -- one visitor's search URL advertised on another
    // visitor's foodbank page.
    const first = buildPageContext({ path: "/needs/", locale: "en", unprefixedPath: "/needs/" });
    const firstEntry = first.languages[0];
    if (firstEntry) firstEntry.url = "/scribbled-on/";
    first.languages.pop();

    const second = buildPageContext({ path: "/needs/", locale: "en", unprefixedPath: "/needs/" });
    expect(second.languages).toHaveLength(4);
    expect(second.languages[0]).toEqual({ code: "en", name: "English", url: "/needs/" });

    // Empty lists are per-call objects too -- `languages: []` is a literal in
    // the same expression, so a caller that pushed onto one cannot affect the
    // next request's page.
    const noLocale = buildPageContext({ path: "/api/1/" });
    noLocale.languages.push({ code: "en", name: "English", url: "/nope/" });
    expect(buildPageContext({ path: "/api/1/" }).languages).toEqual([]);
  });

  it("keys the list off the PRESENCE of locale, not off its value", () => {
    // `options.locale ? ... : []`. An explicit locale: "en" is what every
    // English page in an i18n-patterned route passes (resolveLanguage sets
    // "en" for an unprefixed path), and it must produce the full list --
    // omitting the option is the ONLY way to say "this route has no
    // translations". The two are one keystroke apart at a call site and
    // produce completely different <head> markup.
    expect(buildPageContext({ path: "/needs/", locale: "en", unprefixedPath: "/needs/" }).languages).toHaveLength(4);
    expect(buildPageContext({ path: "/needs/", unprefixedPath: "/needs/" }).languages).toHaveLength(0);
  });

  it("SUSPECT: defaults unprefixedPath to the prefixed path, doubling the prefix", () => {
    // Pinned as current behaviour, reported as a suspected bug rather than
    // fixed. `options.unprefixedPath ?? options.path` is a safe default only
    // for an English page, where the two are the same string. Pass a Welsh
    // page's own path and forget the second argument -- an easy omission,
    // since `unprefixedPath` is optional and the other four options are not
    // paired with anything -- and every alternate URL gains a second prefix:
    // /cy/cy/needs/, /cy/ga/... no, /ga/cy/needs/, none of which resolve.
    //
    // Nothing in the Worker does this today: every i18n-patterned call site
    // passes c.get("pathAfterPrefix") from resolveLanguage.ts. It is asserted
    // because it is the shape a NEW route gets wrong by default, and because
    // the result is a page that renders perfectly with four dead links in the
    // language switcher and four dead hreflangs in its head.
    const ctx = buildPageContext({ path: "/cy/needs/", locale: "cy" });
    expect(ctx.languages.map((l) => l.url)).toEqual(["/cy/needs/", "/cy/cy/needs/", "/ga/cy/needs/", "/gd/cy/needs/"]);
  });

  it("handles the empty unprefixed path that a prefix-only URL produces", () => {
    // resolveLanguage.ts computes pathAfterPrefix as
    // `pathname.slice(first.length + 1)`, which for the prefix-only URL "/cy"
    // (no trailing slash) is the empty string rather than "/". The English
    // alternate then has an EMPTY href, which page.njk:25 renders as
    // `href="{{ domain }}{{ language.url }}"` -- the bare domain, no path --
    // and langswitcher.njk renders as `href=""`, i.e. a link back to the
    // current URL. Pinned as the edge case it is; the fix, if one is wanted,
    // belongs in resolveLanguage rather than here.
    const ctx = buildPageContext({ path: "/cy", locale: "cy", unprefixedPath: "" });
    expect(ctx.languages.map((l) => l.url)).toEqual(["", "/cy", "/ga", "/gd"]);
  });
});

// ---------------------------------------------------------------------------
// language_code / language_name / language_direction
// ---------------------------------------------------------------------------

describe("buildPageContext: the language fields", () => {
  it("names each of the four languages in its own language", () => {
    // page.njk:2 puts language_code in <html lang>, plausible.init() reports
    // it as a custom property, and langswitcher.njk prints language_name. The
    // names are name_local, not English names -- "Cymraeg", not "Welsh" --
    // which is what a Welsh speaker looking for their language in a dropdown
    // is scanning for. Verified against Django 5.2.6's LANG_INFO on this
    // machine (see the languages test above for the exact command).
    const named = (locale: Locale) => {
      const ctx = buildPageContext({ path: "/", locale, unprefixedPath: "/" });
      return [ctx.language_code, ctx.language_name];
    };
    expect(named("en")).toEqual(["en", "English"]);
    expect(named("cy")).toEqual(["cy", "Cymraeg"]);
    expect(named("ga")).toEqual(["ga", "Gaeilge"]);
    expect(named("gd")).toEqual(["gd", "Gàidhlig"]);
  });

  it("falls back to English when no locale is given", () => {
    // `options.locale ?? "en"` -- the API docs pages again. Django got this
    // from request.LANGUAGE_CODE, which LocaleMiddleware always set; here it
    // is a default, and it must be a real language rather than an empty
    // string, because <html lang=""> is invalid and screen readers fall back
    // to the user agent's locale when they see it.
    const ctx = buildPageContext({ path: "/api/1/" });
    expect(ctx.language_code).toBe("en");
    expect(ctx.language_name).toBe("English");
    expect(ctx.language_direction).toBe("ltr");
  });

  it("is always ltr, for every one of the four languages", () => {
    // Django computed this from get_language_info(code)['bidi'] and could
    // return "rtl"; this port hardcodes "ltr" on the grounds that the only two
    // RTL entries in Django's LANGUAGES (ur and ar) are among the 17 dropped.
    // Checked rather than believed: LANG_INFO's `bidi` is False for all four
    // of en/cy/ga/gd in the Django 5.2.6 installed here, so the constant is
    // correct for every language this Worker can serve.
    //
    // It matters in two places beyond <html dir>: page.njk sets a
    // `txt-dir-{{ language_direction }}` class, and langswitcher.njk picks
    // is-pulled-right vs is-pulled-left off it. Add a fifth, RTL language to
    // i18n.ts and this constant is what silently mis-renders.
    for (const locale of ["en", "cy", "ga", "gd"] as Locale[]) {
      expect(buildPageContext({ path: "/", locale, unprefixedPath: "/" }).language_direction).toBe("ltr");
    }
  });

  it("PINNED, NOT ENDORSED: an out-of-range locale yields an undefined language_name", () => {
    // Reachable only through a cast, but a cast is exactly what every route
    // does: `c.get("lang") as "en" | "cy" | "ga" | "gd"`. Nothing here
    // validates the value, so a locale that is not one of the four indexes
    // LANGUAGE_NAMES to undefined and reaches nunjucks in a field typed
    // `string`. The page still renders -- throwOnUndefined is off -- with an
    // empty language name in the switcher and a bogus <html lang>.
    //
    // Not a live bug: resolveLanguage.ts only ever sets "en" or a member of
    // PREFIXES, both derived from LOCALES. Asserted so that the safety is
    // known to live THERE and not here, and so a future caller that resolves
    // a language from, say, a stored user preference knows it must validate
    // first.
    const ctx = buildPageContext({ path: "/", locale: "pl" as Locale, unprefixedPath: "/" });
    expect(ctx.language_code).toBe("pl");
    expect(ctx.language_name as string | undefined).toBeUndefined();
    // The alternates are still the four real languages, so the switcher shows
    // no current-language label at all (no entry matches language_code).
    expect(ctx.languages.map((l) => l.code)).toEqual(["en", "cy", "ga", "gd"]);
  });
});

// ---------------------------------------------------------------------------
// the three page-shape booleans
// ---------------------------------------------------------------------------

describe("buildPageContext: page_translatable, headless and is_flag_page", () => {
  it("defaults all three to false", () => {
    // Each `?? false` decides whether a whole block of markup renders:
    //   page_translatable -> the hreflang alternates (page.njk:24) and the
    //     entire language switcher (langswitcher.njk wraps everything in it)
    //   headless          -> page.njk's header and footer chrome, off for the
    //     Turnstile relay page (routes/human.ts) only
    //   is_flag_page      -> the "Something wrong in this page?" link, which
    //     the flag page itself must not show
    // Defaulting to false means a new route renders an ordinary, untranslated
    // page until it says otherwise -- the safe direction in all three cases.
    const ctx = buildPageContext({ path: "/api/1/" });
    expect(ctx.page_translatable).toBe(false);
    expect(ctx.headless).toBe(false);
    expect(ctx.is_flag_page).toBe(false);
  });

  it("passes each one through when set, including an explicit false", () => {
    const on = buildPageContext({ path: "/needs/", pageTranslatable: true, headless: true, isFlagPage: true });
    expect([on.page_translatable, on.headless, on.is_flag_page]).toEqual([true, true, true]);

    const off = buildPageContext({ path: "/needs/", pageTranslatable: false, headless: false, isFlagPage: false });
    expect([off.page_translatable, off.headless, off.is_flag_page]).toEqual([false, false, false]);

    // An explicitly-undefined option takes the default rather than reaching
    // the template as undefined -- which is how these arrive from a call site
    // that spreads an options object built with optional fields.
    const undef = buildPageContext({ path: "/needs/", pageTranslatable: undefined, headless: undefined, isFlagPage: undefined });
    expect([undef.page_translatable, undef.headless, undef.is_flag_page]).toEqual([false, false, false]);
  });

  it("does not derive page_translatable from the path, as Django did", () => {
    // A divergence with teeth. context_processors.py:30-31 computed it:
    //   page_translatable = "/cy/" == translate_url(path, "cy")[:4]
    // i.e. "would this URL still resolve if it were Welsh?", which is true for
    // everything inside i18n_patterns and false for everything outside. Here
    // it is an explicit flag at each call site, so a new i18n-patterned route
    // that forgets `pageTranslatable: true` loses its hreflang alternates and
    // its language switcher with no error and no visible gap on the page.
    //
    // Asserted from the direction that would catch that: a path that IS
    // translatable, with the flag left off, still reports false.
    expect(buildPageContext({ path: "/cy/needs/", locale: "cy", unprefixedPath: "/needs/" }).page_translatable).toBe(false);
    // ...and the alternates are still built, so `languages` and
    // `page_translatable` are independent -- the list exists but no template
    // renders it.
    expect(buildPageContext({ path: "/cy/needs/", locale: "cy", unprefixedPath: "/needs/" }).languages).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// setRuntimeIdentity -- context_processors.py:22-29's Coolify variables
// ---------------------------------------------------------------------------

describe("setRuntimeIdentity", () => {
  it("reports 'unknown' for all four fields before any request has run", () => {
    // UNKNOWN_IDENTITY, deliberately distinguishable from a real value: a page
    // rendered outside a request (a script, a test, a cron-side render) says
    // so rather than claiming a colo that never saw it. Django's equivalent
    // was the string "LOCALHOST" when the Coolify variables were absent.
    //
    // This needs a virgin module because the setter is one-way -- see the
    // helper. It is also why this test cannot simply run first and hope.
    return expect(contextFromVirginModule({ path: "/" })).resolves.toMatchObject({
      colo: "unknown",
      instance_id: "unknown",
      version: "unknown",
      commit: null,
    });
  });

  it("publishes all four fields to every context built afterwards", () => {
    // The middleware calls this ONCE PER ISOLATE (middleware/runtimeIdentity.ts)
    // and every one of the ~60 buildPageContext() call sites then picks the
    // values up implicitly. That indirection is the module's whole design, and
    // it is what stops these four being threaded through every call site --
    // so "a context built later sees them" is the actual contract.
    setRuntimeIdentity({ colo: "LHR", instanceId: "deadbee", version: "9b11b27", commit: "9b11b27" });

    const ctx = buildPageContext({ path: "/needs/", locale: "cy", unprefixedPath: "/needs/" });
    expect(ctx.colo).toBe("LHR");
    expect(ctx.instance_id).toBe("deadbee");
    expect(ctx.version).toBe("9b11b27");
    expect(ctx.commit).toBe("9b11b27");

    // Note the field rename across the boundary: instanceId in, instance_id
    // out. debugcomment.njk reads the snake_case name, so this mapping is the
    // only thing standing between the middleware's TS-shaped object and the
    // template's Django-shaped one.
    const asRecord = ctx as unknown as Record<string, unknown>;
    expect("instanceId" in asRecord).toBe(false);
  });

  it("carries a null commit through as null rather than inventing a string", () => {
    // The normal production case: nothing tags Worker deploys with a git SHA,
    // so `commit` is null and debugcomment.njk's `{% if commit %}` drops the
    // GitHub commit link entirely. Coerce it to "" or "unknown" here and the
    // template would render a github.com/.../commit/unknown link that 404s --
    // which is the exact failure runtimeIdentity.ts's SHA check exists to
    // avoid, undone one layer further down.
    setRuntimeIdentity({ colo: "MAN", instanceId: "abc1234", version: "3f8a1c2e", commit: null });
    expect(buildPageContext({ path: "/" }).commit).toBeNull();
  });

  it("lets the last write win, and touches nothing else in the context", () => {
    // There is no guard on the setter -- the once-per-isolate rule is the
    // middleware's (`if (!identity)`), not this module's. Pinned because it
    // means a second caller silently redefines what every subsequent page
    // reports, and because it is what makes this module testable at all.
    setRuntimeIdentity({ colo: "LHR", instanceId: "1111111", version: "aaaaaaaa", commit: null });
    setRuntimeIdentity({ colo: "SYD", instanceId: "2222222", version: "bbbbbbbb", commit: "feedbee" });

    const ctx = buildPageContext({ path: "/needs/", querystring: "address=X", locale: "en", unprefixedPath: "/needs/" });
    expect([ctx.colo, ctx.instance_id, ctx.version, ctx.commit]).toEqual(["SYD", "2222222", "bbbbbbbb", "feedbee"]);
    // The identity is orthogonal to the page: switching isolates must not
    // change a single thing about what page this is.
    expect(ctx.canonical_path).toBe(`${DOMAIN}/needs/`);
    expect(ctx.flag_path).toBe(`${DOMAIN}/needs/?address=X`);
    expect(ctx.languages).toHaveLength(4);
  });

  it("copies the four values into each context, so a rendered page cannot be edited into another", () => {
    // Each context gets its own strings rather than a reference to the shared
    // identity object. A route that mutated its context before rendering --
    // several spread it and add to it -- must not be able to change what the
    // NEXT page reports as its colo or version.
    setRuntimeIdentity({ colo: "LHR", instanceId: "deadbee", version: "9b11b27", commit: null });
    const first = buildPageContext({ path: "/" });
    first.colo = "MARS";
    first.version = "tampered";
    expect(buildPageContext({ path: "/" })).toMatchObject({ colo: "LHR", version: "9b11b27" });
  });

  it("SUSPECT: stores the caller's object by reference, so later mutation rewrites live pages", () => {
    // Pinned, not fixed. `runtimeIdentity = identity` keeps the object the
    // caller passed, and middleware/runtimeIdentity.ts passes its OWN
    // module-scope `identity` object -- the same one it keeps for its
    // `if (!identity)` check. Nothing mutates it today, so this is latent
    // rather than live, but it means the two modules share one mutable object
    // across every request the isolate serves: anything that later assigned
    // to a field of it (a "refresh the colo per request" change, say) would
    // retroactively alter what every subsequent page reports, with no call to
    // the setter and nothing in this file to show for it. A shallow copy in
    // setRuntimeIdentity() would close it.
    const identity = { colo: "LHR", instanceId: "deadbee", version: "9b11b27", commit: null as string | null };
    setRuntimeIdentity(identity);
    expect(buildPageContext({ path: "/" }).colo).toBe("LHR");

    identity.colo = "SYD";
    identity.commit = "9b11b27";
    expect(buildPageContext({ path: "/" })).toMatchObject({ colo: "SYD", commit: "9b11b27" });
  });
});

// ---------------------------------------------------------------------------
// the whole object
// ---------------------------------------------------------------------------

describe("buildPageContext: the object as a whole", () => {
  it("has exactly these fourteen keys, in snake_case", () => {
    // The list is the contract with 150 precompiled templates, and it is
    // snake_case on purpose (the module's own opening comment: the object is
    // handed straight to nunjucks, so the names ARE the template variable
    // names). Renaming one to camelCase, or dropping one, breaks every page
    // that reads it with no error anywhere -- throwOnUndefined is false, so
    // the line simply renders empty.
    //
    // Adding a key is fine; adding one without noticing that it becomes a
    // global on every page in the site is what this catches. Django's context
    // also carried enable_write, app_name and facebook_locale: the first two
    // are now per-route values (routes/public.ts passes enable_write itself,
    // app_name was deleted with debugcomment's "By app" line on 2026-09-05),
    // and facebook_locale is set by the two routes whose templates embed
    // Facebook (routes/wfbn/foodbank.ts:110, locationDetail.ts:106).
    const ctx = buildPageContext({ path: "/needs/", locale: "en", unprefixedPath: "/needs/" });
    expect(Object.keys(ctx).sort()).toEqual([
      "canonical_path",
      "colo",
      "commit",
      "domain",
      "flag_path",
      "headless",
      "instance_id",
      "is_flag_page",
      "language_code",
      "language_direction",
      "language_name",
      "languages",
      "page_translatable",
      "version",
    ]);
  });

  it("builds the whole context for a real Welsh search page, field for field", () => {
    // One end-to-end fixture with every option supplied, asserted whole rather
    // than field by field: this is the exact call routes/wfbn/index.ts makes
    // for GET /cy/needs/?address=SW1A+1AA, with the identity a live isolate
    // would have published. A field-by-field suite can drift into passing
    // while the object as a whole is wrong (an option wired to the wrong
    // field, say); toEqual on the complete object cannot.
    setRuntimeIdentity({ colo: "LHR", instanceId: "deadbee", version: "3f8a1c2e", commit: null });

    expect(
      buildPageContext({
        path: "/cy/needs/",
        querystring: "address=SW1A+1AA",
        pageTranslatable: true,
        locale: "cy",
        unprefixedPath: "/needs/",
      }),
    ).toEqual({
      canonical_path: `${DOMAIN}/cy/needs/`,
      flag_path: `${DOMAIN}/cy/needs/?address=SW1A+1AA`,
      colo: "LHR",
      instance_id: "deadbee",
      version: "3f8a1c2e",
      commit: null,
      domain: DOMAIN,
      page_translatable: true,
      languages: [
        { code: "en", name: "English", url: "/needs/" },
        { code: "cy", name: "Cymraeg", url: "/cy/needs/" },
        { code: "ga", name: "Gaeilge", url: "/ga/needs/" },
        { code: "gd", name: "Gàidhlig", url: "/gd/needs/" },
      ],
      language_code: "cy",
      language_name: "Cymraeg",
      language_direction: "ltr",
      headless: false,
      is_flag_page: false,
    });
  });
});

// ---------------------------------------------------------------------------
// through the real templates
// ---------------------------------------------------------------------------

// Everything above asserts the object. These assert that the object is the one
// the templates actually read -- through the REAL nunjucks environment and the
// REAL precompiled templates, not a stub. That is the only way to catch the
// failure this module is most exposed to: nunjucks renders an unknown variable
// as the empty string (env.ts:49, deliberately, matching Django), so a
// misnamed field produces a page that renders perfectly and says nothing.
describe("the context as the templates read it", () => {
  it("fills every line of the debug comment", async () => {
    // includes/debugcomment.njk is the reason colo, instance_id, version and
    // commit exist at all. It is also the block people paste into a bug
    // report, so a blank line here costs exactly the information the report
    // was supposed to carry. Until 2026-09-05 two of these lines were
    // hardcoded constants; nothing noticed for the life of the deploy.
    //
    // Matched without the emoji prefixes: the label text is the contract, the
    // decoration is not.
    setRuntimeIdentity({ colo: "LHR", instanceId: "deadbee", version: "9b11b27", commit: "9b11b27" });
    const ctx = buildPageContext({ path: "/cy/needs/", pageTranslatable: true, locale: "cy", unprefixedPath: "/needs/" });

    const html = await render("includes/debugcomment.njk", { ...ctx, render_time_ms: 12 }, "cy");
    expect(html).toContain("In colo LHR");
    expect(html).toContain("By machine deadbee");
    expect(html).toContain("Using code 9b11b27");
    expect(html).toContain("Language Cymraeg");
    expect(html).toContain("Language code cy");
    expect(html).toContain("Language direction ltr");
    expect(html).toContain("Code version https://github.com/givefood/givefood/commit/9b11b27");
  });

  it("drops the commit link when there is no commit, rather than linking to nothing", async () => {
    // `{% if commit %}` against the null this module passes through. The
    // untagged deploy is the normal case, so this is the branch that actually
    // renders in production.
    setRuntimeIdentity({ colo: "LHR", instanceId: "deadbee", version: "3f8a1c2e", commit: null });
    const html = await render("includes/debugcomment.njk", buildPageContext({ path: "/" }) as unknown as Record<string, unknown>);
    expect(html).toContain("Using code 3f8a1c2e");
    expect(html).not.toContain("/commit/");
    // The pre-request default renders as the word "unknown" rather than as a
    // blank line, which is the point of UNKNOWN_IDENTITY being a string.
    const virgin = await contextFromVirginModule({ path: "/" });
    const unknownHtml = await render("includes/debugcomment.njk", virgin as unknown as Record<string, unknown>);
    expect(unknownHtml).toContain("In colo unknown");
    expect(unknownHtml).toContain("By machine unknown");
  });

  it("drives the language switcher's links and its current-language label", async () => {
    // langswitcher.njk reads .url, .name and .code off each entry and matches
    // language_code against them to label the button. Rendering it is what
    // proves the three key names, the order and the URLs simultaneously -- an
    // entry renamed from `url` to `href` would leave four dropdown items with
    // no destination and every object-level assertion above still passing.
    const ctx = buildPageContext({ path: "/cy/needs/", pageTranslatable: true, locale: "cy", unprefixedPath: "/needs/" });
    const html = await render("includes/langswitcher.njk", { ...ctx }, "cy");

    expect(html).toContain('<a href="/needs/" class="dropdown-item">');
    expect(html).toContain('<a href="/cy/needs/" class="dropdown-item">');
    expect(html).toContain('<a href="/ga/needs/" class="dropdown-item">');
    expect(html).toContain('<a href="/gd/needs/" class="dropdown-item">');
    // The button label is the CURRENT language, found by the code match.
    expect(html.split("dropdown-menu")[0]).toContain("Cymraeg");
    // ...and the four links come out in the context's order.
    const linkOrder = [...html.matchAll(/dropdown-item/g)].length;
    expect(linkOrder).toBe(4);
    expect(html.indexOf('href="/cy/needs/"')).toBeLessThan(html.indexOf('href="/gd/needs/"'));
  });

  it("renders no switcher at all when the page is not translatable", async () => {
    // Both halves of the guard, because they fail differently. A page that is
    // flagged untranslatable renders nothing (the whole file is inside
    // `{% if page_translatable %}`); a page with an empty `languages` list --
    // an API docs page -- renders the wrapper with no links in it, which is a
    // visible empty dropdown rather than a hidden one.
    const untranslatable = await render("includes/langswitcher.njk", { ...buildPageContext({ path: "/api/1/" }) });
    expect(untranslatable.trim()).toBe("");

    const noAlternates = await render("includes/langswitcher.njk", {
      ...buildPageContext({ path: "/api/1/", pageTranslatable: true }),
    });
    expect(noAlternates).toContain("langswitcher");
    expect(noAlternates).not.toContain("dropdown-item");
  });

  it("puts canonical, hreflang and <html lang> on a real page render", async () => {
    // The full base template, which is where three separate context fields
    // meet the markup that search engines read: canonical_path, the
    // languages/domain pair behind every hreflang, and
    // language_code/language_direction on <html>. page.njk composes
    // `{{ domain }}{{ language.url }}` itself, so the alternates being
    // RELATIVE in the context and ABSOLUTE in the page is a contract between
    // these two files and nowhere else.
    setRuntimeIdentity({ colo: "LHR", instanceId: "deadbee", version: "9b11b27", commit: null });
    const ctx = buildPageContext({ path: "/cy/needs/", pageTranslatable: true, locale: "cy", unprefixedPath: "/needs/" });
    const html = await render("page.njk", { ...ctx }, "cy");

    expect(html.startsWith('<!DOCTYPE html>\n<html lang="cy" dir="ltr" class="txt-dir-ltr">')).toBe(true);
    expect(html).toContain(`<link rel="canonical" href="${DOMAIN}/cy/needs/">`);
    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${DOMAIN}/needs/">`);
    expect(html).toContain(`<link rel="alternate" hreflang="cy" href="${DOMAIN}/cy/needs/">`);
    expect(html).toContain(`<link rel="alternate" hreflang="ga" href="${DOMAIN}/ga/needs/">`);
    expect(html).toContain(`<link rel="alternate" hreflang="gd" href="${DOMAIN}/gd/needs/">`);
    // `version` is also the cache-buster on every stylesheet link, which is a
    // second, entirely separate consumer of the identity: ship the same
    // version string for two deploys and browsers serve the old CSS.
    expect(html).toContain("/static/css/gf.css?v=9b11b27");
  });

  it("emits no alternates when the page is not translatable, even though the list exists", async () => {
    // page.njk:24 guards the hreflang loop on page_translatable, not on the
    // list being non-empty -- so a route that builds alternates but forgets
    // the flag advertises none of them. This is the rendered half of the
    // "does not derive page_translatable from the path" test above, and the
    // reason that divergence is worth naming: the failure is a page with a
    // complete, correct, entirely unused set of translations.
    const ctx = buildPageContext({ path: "/cy/needs/", locale: "cy", unprefixedPath: "/needs/" });
    const html = await render("page.njk", { ...ctx }, "cy");
    expect(ctx.languages).toHaveLength(4);
    expect(html).not.toContain("hreflang");
    expect(html).toContain(`<link rel="canonical" href="${DOMAIN}/cy/needs/">`);
  });

  it("escapes the flag link's query string instead of trusting it", async () => {
    // flag_path is built from the raw request query string and interpolated
    // into an href by page.njk:55. Nothing in this module escapes it -- and
    // must not, since autoescape would double-encode -- so the safety is the
    // environment's. Asserted here because the two decisions are only correct
    // TOGETHER: turning autoescape off in env.ts, or "helpfully" escaping in
    // buildPageContext, each turns a reflected query string into markup on
    // every page of the site.
    const ctx = buildPageContext({ path: "/needs/", querystring: 'a="><script>alert(1)</script>' });
    const html = await render("page.njk", { ...ctx });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
