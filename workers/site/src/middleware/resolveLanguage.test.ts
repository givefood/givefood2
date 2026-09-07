import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { LOCALES } from "@givefood/templates";
import { PREFIXES, resolveLanguage } from "./resolveLanguage";
import type { AppEnv } from "../types";

// The port of Django's LocaleMiddleware + i18n_patterns(prefix_default_language=False).
// PLAN.md §6.1.2 calls this behaviour "counter-intuitive, and must be pinned
// by tests rather than reimplemented from instinct" -- so this file pins it,
// row by row, against the table of live-verified production responses in that
// section.
//
// Two things are actually at stake, and every test below defends one of them:
//
//   1. NO CONTENT NEGOTIATION. Django computes the session key, the
//      django_language cookie and Accept-Language, then throws all three
//      away: the URL prefix is the only signal that ever wins. The obvious
//      "improvement" -- honouring Accept-Language when no prefix is present
//      -- would change what every visitor sees AND fragment the edge cache
//      per language, which PLAN.md names as the cheapest possible way to
//      make the site slower. A test that merely checked "/cy/ resolves to
//      cy" would not notice that regression, so the tests here send
//      Accept-Language and Cookie headers that a negotiating implementation
//      would act on, and assert they are ignored.
//
//   2. THE Vary SPLIT. `/en/` and `/de/` both 404 with Content-Language: en,
//      yet only `/de/` carries `Vary: Accept-Language`. That is not a
//      cosmetic difference: it is the visible trace of whether Django's
//      language-negotiation function ran at all. `get_language_from_path`
//      recognises "en" (it is a real LANGUAGES entry, just never a
//      registered prefix), so LocaleMiddleware never falls through to
//      get_language_from_request() -- and it is that function which patches
//      Vary on the way out. The module's own comment records that this was
//      found by testing output against PLAN.md's header table, not by
//      reading the code: the comment was right and the condition was wrong.
//      A single `if (!prefixed)` looks perfectly reasonable in a diff, so
//      these two rows are asserted separately and explicitly.

// Nothing in this middleware touches a binding; Hono just needs something
// to pass through as c.env.
const env = {} as unknown as AppEnv["Bindings"];

/** What the middleware puts on the context, plus the headers it puts on the way out. */
async function resolve(url: string, init: RequestInit = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", resolveLanguage);
  app.all("*", (c) => c.json({ lang: c.get("lang"), pathAfterPrefix: c.get("pathAfterPrefix") }));
  const res = await app.request(url, init, env);
  const vars = (await res.json()) as { lang: string; pathAfterPrefix: string };
  return {
    ...vars,
    status: res.status,
    contentLanguage: res.headers.get("Content-Language"),
    vary: res.headers.get("Vary"),
  };
}

// index.ts registers every i18n_patterns route twice over: once bare (English
// carries no prefix -- prefix_default_language=False) and once under each
// non-English locale. Reproduced in miniature, and with the routes spelled
// out rather than generated from PREFIXES, so that /en/, /de/ and /zh-hans/
// genuinely miss the router here exactly as they do in production. Without a
// real router the 404 half of PLAN.md's header table cannot be tested at all.
function siteLikeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", resolveLanguage);
  app.get("/", (c) => c.text("index"));
  app.get("/needs/", (c) => c.text("wfbn index"));
  for (const prefix of ["cy", "ga", "gd"]) {
    app.get(`/${prefix}/`, (c) => c.text("index"));
    app.get(`/${prefix}/needs/`, (c) => c.text("wfbn index"));
  }
  return app;
}

// Django's LANGUAGES minus the four this Worker kept (givefood/settings.py:233).
// PLAN.md §2.7.1 dropped these 17 catalogues rather than porting them.
const DROPPED_DJANGO_LANGUAGES = [
  "pl",
  "bn",
  "ro",
  "pa",
  "ur",
  "ar",
  "gu",
  "es",
  "pt",
  "it",
  "ta",
  "fr",
  "lt",
  "zh-hans",
  "tr",
  "bg",
  "tlh",
];

/**
 * Re-import the middleware with a substituted LOCALES.
 *
 * The module's headline claim -- "Derived from @givefood/templates' LOCALES,
 * not a second hardcoded list" -- is untestable against today's LOCALES,
 * because today's LOCALES ARE cy/ga/gd: a re-hardcoded `new Set(["cy","ga",
 * "gd"])` agrees with the real implementation on every input that exists. The
 * only way to tell the two apart is to change LOCALES and see whether the
 * middleware moves with it, in both directions -- a language added and a
 * language removed.
 */
async function withLocales<T>(
  locales: string[],
  fn: (fresh: typeof import("./resolveLanguage")) => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("@givefood/templates", async () => {
    const actual = await vi.importActual<typeof import("@givefood/templates")>("@givefood/templates");
    return { ...actual, LOCALES: locales as unknown as typeof actual.LOCALES };
  });
  try {
    return await fn(await import("./resolveLanguage"));
  } finally {
    // Leave the registry as it was found: every other test in this file
    // imports the real LOCALES at module scope.
    vi.doUnmock("@givefood/templates");
    vi.resetModules();
  }
}

/** resolve(), but against a specific (re-imported) copy of the middleware. */
async function resolveWith(mod: typeof import("./resolveLanguage"), url: string) {
  const app = new Hono<AppEnv>();
  app.use("*", mod.resolveLanguage);
  app.all("*", (c) => c.json({ lang: c.get("lang"), pathAfterPrefix: c.get("pathAfterPrefix") }));
  const res = await app.request(url, {}, env);
  const vars = (await res.json()) as { lang: string; pathAfterPrefix: string };
  return {
    ...vars,
    contentLanguage: res.headers.get("Content-Language"),
    vary: res.headers.get("Vary"),
  };
}

describe("PREFIXES", () => {
  it("does not contain 'en'", () => {
    // The single most load-bearing fact in the module. `en` being absent is
    // what makes /en/ a 404 rather than a working English page, and it is
    // also what makes /en/ take the `bareEn` branch below instead of the
    // prefixed one. Adding "en" here would quietly turn /en/ into a second,
    // duplicate canonical URL for every page on the site -- and split the
    // edge cache in two while it did.
    expect(PREFIXES.has("en")).toBe(false);
  });

  it("is exactly the three non-English languages of PLAN.md §2.7.1", () => {
    // cy/ga/gd -- Welsh, Irish, Scottish Gaelic. Pinned as a literal so that
    // a change to the supported-language set has to be a deliberate edit to
    // this expectation, not something that arrives as a side effect.
    expect([...PREFIXES].sort()).toEqual(["cy", "ga", "gd"]);
  });

  it("promotes every non-English LOCALES entry to a prefix", () => {
    // The module's stated reason for deriving this set instead of writing a
    // second hardcoded list: adding a 5th language must mean editing
    // i18n.ts's LOCALES and nothing else. If someone ever re-hardcodes this
    // set, a new locale would translate but not route, and this fails.
    for (const locale of LOCALES) {
      expect(PREFIXES.has(locale)).toBe(locale !== "en");
    }
  });

  it("still tracks LOCALES when a fifth language is added to it", async () => {
    // The test above compares PREFIXES against today's LOCALES, and today's
    // LOCALES happen to be cy/ga/gd -- so a re-hardcoded
    // `new Set(["cy","ga","gd"])` passes it, and passes every other test in
    // this file. The module's headline claim ("Derived from @givefood/
    // templates' LOCALES, not a second hardcoded list ... adding a 5th
    // language means editing i18n.ts's LOCALES and having every consumer
    // pick it up, not remembering to update N independent copies") is only
    // actually testable by changing LOCALES, so this changes it: swap in a
    // Cornish locale, re-import the module, and require that the new code
    // routes -- resolves, strips its prefix and suppresses Vary -- with no
    // edit to this file's own list. If someone re-hardcodes the set, the
    // translations for language five would ship and the URLs would 404.
    await withLocales(["en", "cy", "ga", "gd", "kw"], async (fresh) => {
      expect([...fresh.PREFIXES].sort()).toEqual(["cy", "ga", "gd", "kw"]);
      expect(fresh.PREFIXES.has("en")).toBe(false);

      const r = await resolveWith(fresh, "https://www.givefood.org.uk/kw/needs/");
      expect(r).toMatchObject({ lang: "kw", pathAfterPrefix: "/needs/", contentLanguage: "kw", vary: null });
    });
  });

  it("keeps 'en' out of the set wherever it sits in LOCALES", async () => {
    // The test above adds a locale to the END of a LOCALES that still starts
    // with "en", so `LOCALES.slice(1)` -- "drop the default language, it's
    // the first one" -- produces cy/ga/gd/kw and passes it, along with every
    // other test in this file. It is a genuinely tempting way to write the
    // line, and it is wrong the moment i18n.ts lists the locales in any other
    // order (alphabetically, say, or newest-first): "cy" would silently
    // become the excluded default, /cy/ would stop routing, and "en" would
    // become a prefix -- a second URL for every English page.
    //
    // The real filter is on the VALUE, so put "en" last and require the same
    // three prefixes, and require /en/ to keep behaving like /en/ (path
    // handed on whole, no Vary) rather than becoming a stripped prefix.
    await withLocales(["cy", "ga", "gd", "en"], async (fresh) => {
      expect([...fresh.PREFIXES].sort()).toEqual(["cy", "ga", "gd"]);
      expect(fresh.PREFIXES.has("en")).toBe(false);

      const en = await resolveWith(fresh, "https://www.givefood.org.uk/en/needs/");
      expect(en).toMatchObject({ lang: "en", pathAfterPrefix: "/en/needs/", vary: null });
      const cy = await resolveWith(fresh, "https://www.givefood.org.uk/cy/needs/");
      expect(cy).toMatchObject({ lang: "cy", pathAfterPrefix: "/needs/" });
    });
  });

  it("stops routing a language that LOCALES no longer lists", async () => {
    // The other direction, and the one that catches the sneakiest wrong
    // implementation of all: `new Set([...LOCALES.filter(...), "cy","ga","gd"])`
    // -- or any hardcoded list kept "for safety" alongside the derived one --
    // passes the fifth-language test above, because adding still works. Only
    // REMOVAL exposes it.
    //
    // This is not hypothetical housekeeping: §2.7.1 is itself a language
    // removal (17 of Django's 21 catalogues were dropped), so the next such
    // decision must be one edit to i18n.ts. If /gd/ kept routing after "gd"
    // left LOCALES, loadCatalogue would be asked for a catalogue that no
    // longer ships, and the URLs would keep being advertised as alternates.
    await withLocales(["en", "cy"], async (fresh) => {
      expect([...fresh.PREFIXES].sort()).toEqual(["cy"]);
      expect(fresh.PREFIXES.has("gd")).toBe(false);

      // /gd/ must now be indistinguishable from /de/: English, path intact,
      // negotiation "ran" so Vary is present.
      const gd = await resolveWith(fresh, "https://www.givefood.org.uk/gd/needs/");
      expect(gd).toMatchObject({
        lang: "en",
        pathAfterPrefix: "/gd/needs/",
        contentLanguage: "en",
        vary: "Accept-Language",
      });
      // ...and the survivor still routes, so this is a narrowing, not a break.
      expect(await resolveWith(fresh, "https://www.givefood.org.uk/cy/")).toMatchObject({ lang: "cy" });
    });
  });

  it("is empty, and still resolves every URL, when LOCALES is English-only", async () => {
    // The empty boundary: `LOCALES.filter(l => l !== "en")` on a one-element
    // array yields [], and `new Set([])` is a legal, empty prefix set. An
    // implementation that treated an empty derivation as "something went
    // wrong" and fell back to a default list would resurrect /cy/ as a live
    // URL for a language with no catalogue; one that indexed into the array
    // (LOCALES[1], or a `[first]` lookup) would throw on the site's busiest
    // request instead. Neither may happen: with no translations, every URL
    // is simply English and nothing is ever stripped.
    await withLocales(["en"], async (fresh) => {
      expect(fresh.PREFIXES.size).toBe(0);

      const cy = await resolveWith(fresh, "https://www.givefood.org.uk/cy/needs/");
      expect(cy).toMatchObject({ lang: "en", pathAfterPrefix: "/cy/needs/", vary: "Accept-Language" });
      const root = await resolveWith(fresh, "https://www.givefood.org.uk/");
      expect(root).toMatchObject({ lang: "en", pathAfterPrefix: "/", contentLanguage: "en" });
      // "en" is still special even with nothing to be special against.
      const en = await resolveWith(fresh, "https://www.givefood.org.uk/en/");
      expect(en).toMatchObject({ lang: "en", pathAfterPrefix: "/en/", vary: null });
    });
  });

  it("does not recognise the 17 Django languages that were dropped", () => {
    // §2.7.1's divergence, stated as a set rather than a comment: /pl/ and
    // /zh-hans/ were 200s in Django and must now miss the prefix set, so
    // they land on the same "no prefix => en" path /de/ already took.
    for (const code of DROPPED_DJANGO_LANGUAGES) {
      expect(PREFIXES.has(code)).toBe(false);
    }
  });
});

describe("resolveLanguage: rule 1, the path prefix wins", () => {
  it("resolves each supported prefix and strips it from the path", async () => {
    for (const prefix of ["cy", "ga", "gd"]) {
      const r = await resolve(`https://www.givefood.org.uk/${prefix}/needs/`);
      expect(r.lang).toBe(prefix);
      // pathAfterPrefix is what context.ts builds the language-switcher
      // alternates from (`/${code}${unprefixedPath}`), so it must keep its
      // leading slash: lose it and every alternate URL becomes /cyneeds/.
      expect(r.pathAfterPrefix).toBe("/needs/");
    }
  });

  it("strips only the first segment, however deep the path", async () => {
    const r = await resolve("https://www.givefood.org.uk/gd/needs/at/sid-valley/donationpoint/asda/");
    expect(r.lang).toBe("gd");
    expect(r.pathAfterPrefix).toBe("/needs/at/sid-valley/donationpoint/asda/");
  });

  it("leaves exactly one slash behind for a locale homepage", async () => {
    // The busiest prefixed URL on the site, and the tightest slice boundary
    // in the module: "/cy/" is 4 characters and 3 of them are consumed.
    // slice(first.length) instead of slice(first.length + 1) yields "y/",
    // slice(first.length + 2) yields "" -- both survive the /cy/needs/ test
    // above only in the sense that they produce *something*, and both make
    // context.ts emit "/cyy/" or "/cy" as the Welsh alternate for the home
    // page. Asserted for all three locales because the codes are the same
    // length, so a wrong offset is uniform and easy to miss.
    for (const prefix of ["cy", "ga", "gd"]) {
      const r = await resolve(`https://www.givefood.org.uk/${prefix}/`);
      expect(r.lang).toBe(prefix);
      expect(r.pathAfterPrefix).toBe("/");
    }
  });

  it("strips the leading code once, not everywhere it appears in the path", async () => {
    // Foodbank slugs are free text, so a path segment that happens to equal
    // a language code is reachable. A `pathname.replaceAll('/cy', '')` or a
    // `split('/').filter(s => s !== first).join('/')` implementation reads
    // as a tidier way to say the same thing and passes every other test
    // here, while silently deleting a slug from the middle of the URL --
    // which context.ts would then publish as the alternate-language href.
    const r = await resolve("https://www.givefood.org.uk/cy/needs/at/cy/");
    expect(r.lang).toBe("cy");
    expect(r.pathAfterPrefix).toBe("/needs/at/cy/");

    const doubled = await resolve("https://www.givefood.org.uk/gd/gd/gd/");
    expect(doubled.lang).toBe("gd");
    expect(doubled.pathAfterPrefix).toBe("/gd/gd/");
  });

  it("beats an Accept-Language header and a cookie that ask for something else", async () => {
    // Rule 1 is "the prefix wins, and is the only thing that ever wins" --
    // in both directions, and against every discarded signal, not just the
    // one. A negotiating implementation would hand this request English; one
    // that consulted django_language (the signal Django computes second and
    // discards just as hard) would hand it Scottish Gaelic. Both are sent
    // here at once, and both lose to four characters of URL. Sending them
    // together also pins the precedence: no ordering of the three inputs
    // produces anything but "cy".
    const r = await resolve("https://www.givefood.org.uk/cy/needs/", {
      headers: { "Accept-Language": "en-GB,en;q=0.9", Cookie: "django_language=gd" },
    });
    expect(r.lang).toBe("cy");
    expect(r.contentLanguage).toBe("cy");
    // And says so on the wire: no Vary means the edge may serve this one
    // cached Welsh page to every visitor regardless of their
    // Accept-Language, which is only safe because the header was ignored.
    // An implementation that read Accept-Language "just to be helpful" and
    // still answered cy would pass the two assertions above.
    expect(r.vary).toBeNull();
  });
});

describe("resolveLanguage: rule 2, no prefix means hard-coded en", () => {
  it("ignores Accept-Language entirely on an unprefixed path", async () => {
    // PLAN.md §6.1.2 row 1, live-verified against production: GET / with
    // Accept-Language: pl is served in English. Django computes the
    // negotiated language and then discards it. This is the test that fails
    // if anyone "improves" this middleware into a content negotiator.
    const r = await resolve("https://www.givefood.org.uk/", {
      headers: { "Accept-Language": "pl,cy;q=0.9,de;q=0.8" },
    });
    expect(r.lang).toBe("en");
    expect(r.contentLanguage).toBe("en");
    // "cy;q=0.9" is deliberately a language this Worker DOES have a
    // catalogue for, so a negotiator would have something real to switch
    // to; the Vary header is present because Django's negotiation function
    // ran and patched it, not because its answer was used.
    expect(r.vary).toBe("Accept-Language");
  });

  it("ignores Accept-Language even when it asks, first and unambiguously, for Welsh", async () => {
    // The test above sends "pl,cy;q=0.9,...", where the highest-priority tag
    // is a language this Worker dropped -- so the commonest wrong
    // implementation of all, `accept-language.split(",")[0]` with a fallback
    // to English, answers "en" and passes it. That is the whole regression
    // slipping through the test written to catch it. Here the header names
    // Welsh at the front, with a region subtag, exactly as a browser
    // configured for Welsh sends it: any negotiator, naive first-tag or full
    // q-value, returns "cy". The middleware must still return "en", because
    // a Welsh speaker who has not asked for /cy/ gets the English page and
    // the edge gets to keep one cached copy of it.
    const r = await resolve("https://www.givefood.org.uk/needs/at/sid-valley/", {
      headers: { "Accept-Language": "cy-GB,cy;q=0.9,en;q=0.5" },
    });
    expect(r.lang).toBe("en");
    expect(r.contentLanguage).toBe("en");
    expect(r.pathAfterPrefix).toBe("/needs/at/sid-valley/");

    // The same header on the site root, where an English-first ordering
    // would otherwise hide the bug: "gd" alone, no fallback offered at all.
    const gd = await resolve("https://www.givefood.org.uk/", { headers: { "Accept-Language": "gd" } });
    expect(gd.lang).toBe("en");
    expect(gd.contentLanguage).toBe("en");

    // And the case where the path and the header AGREE on a language this
    // Worker does not have: a German browser on /de/. Every wrong
    // implementation converges on "de" here -- negotiate the header, or fall
    // back to "use the first path segment when it looks like a language tag"
    // -- and "de" is not a locale this app can load a catalogue for, so the
    // failure would be a thrown 500 or an <html lang="de"> page of English
    // text rather than the plain 404 production serves.
    const de = await resolve("https://www.givefood.org.uk/de/", {
      headers: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.5" },
    });
    expect(de.lang).toBe("en");
    expect(de.contentLanguage).toBe("en");
    expect(de.pathAfterPrefix).toBe("/de/");
    expect(de.vary).toBe("Accept-Language");
  });

  it("ignores a django_language cookie", async () => {
    // The other discarded signal. Django has no set_language view at all
    // (PLAN.md §6.1.2: `path('i18n/', ...)` is not in the URLconf), so this
    // cookie is never set by the site -- but a visitor arriving with one from
    // anywhere else must still get English.
    const r = await resolve("https://www.givefood.org.uk/needs/", {
      headers: { Cookie: "django_language=cy; other=1" },
    });
    expect(r.lang).toBe("en");
    expect(r.contentLanguage).toBe("en");
    // Vary carries Accept-Language and nothing else. This middleware must
    // never add Cookie: noStore.ts owns that (and only for /admin and
    // /auth), and a Vary: Cookie on a public page would make every visitor
    // with any cookie at all a separate edge-cache entry -- the exact
    // fragmentation PLAN.md's "no content negotiation" rule exists to
    // avoid. Reading the cookie is only harmless while nothing is recorded
    // about having read it.
    expect(r.vary).toBe("Accept-Language");
  });

  it("leaves the path untouched when nothing was stripped", async () => {
    for (const path of ["/", "/needs/", "/needs/at/sid-valley/"]) {
      const r = await resolve(`https://www.givefood.org.uk${path}`);
      expect(r.lang).toBe("en");
      expect(r.pathAfterPrefix).toBe(path);
    }
  });
});

describe("resolveLanguage: what does NOT count as a prefix", () => {
  it("never strips /en/, even though it does suppress Vary", async () => {
    // The one case where the two halves of the module disagree on purpose:
    // `bareEn` suppresses Vary, but `prefixed` -- which is what drives the
    // slice -- stays false, so the path is handed on WHOLE. The header table
    // below cannot see this: /en/ 404s identically whether the path was
    // stripped or not. So an implementation that folded the two conditions
    // together (`const prefixed = PREFIXES.has(first) || first === "en"`,
    // or a single `new Set(LOCALES)` used for both) passes every other test
    // in this file while handing render404 an unprefixedPath of "/needs/"
    // for a request to /en/needs/ -- and context.ts would then advertise
    // /cy/needs/ as the Welsh alternate of a URL that does not exist.
    for (const path of ["/en/", "/en/needs/", "/en/needs/at/sid-valley/", "/en"]) {
      const r = await resolve(`https://www.givefood.org.uk${path}`);
      expect(r.lang).toBe("en");
      expect(r.pathAfterPrefix).toBe(path);
      expect(r.contentLanguage).toBe("en");
      expect(r.vary).toBeNull();
    }
  });

  it("requires the whole first segment to match, not a stem of it", async () => {
    // "cymru" starts with "cy" and "gden" starts with "gd". A startsWith()
    // implementation would resolve both and then slice the path at the wrong
    // offset, producing a mangled pathAfterPrefix on top of the wrong
    // language.
    for (const path of ["/cymru/", "/cyfoeth/needs/", "/gden/", "/gaelic/"]) {
      const r = await resolve(`https://www.givefood.org.uk${path}`);
      expect(r.lang).toBe("en");
      expect(r.pathAfterPrefix).toBe(path);
      // And the Vary column agrees that no prefix matched. Asserted because
      // `lang` and `pathAfterPrefix` alone cannot distinguish "startsWith
      // matched but the slice was a no-op" from "nothing matched" on some
      // inputs; the header is the branch made visible.
      expect(r.vary).toBe("Accept-Language");
    }
  });

  it("does not treat an 'en' stem or subtag as the bare-en case", async () => {
    // `bareEn` is an exact `first === "en"`, and Vary is the ONLY place a
    // loosened version of it shows up: /english/ and /en/ both resolve to
    // English and both hand the path on whole, so lang and pathAfterPrefix
    // are identical for the right and the wrong answer. Before this test,
    // nothing in the file asserted the Vary column for an en-lookalike, so
    // `first.startsWith("en")` -- or `pathname.startsWith("/en")`, which is
    // how the condition would most plausibly be rewritten -- passed
    // everything while silently suppressing Vary on an entire family of
    // ordinary English 404s. Suppressing Vary is the dangerous direction: it
    // tells the edge the response does not depend on Accept-Language for
    // URLs where Django says it does.
    //
    // /en-gb/ is here as a Django divergence as well, the mirror of the
    // /cy-gb/ case below: get_supported_language_variant("en-gb") walks back
    // to "en", so Django's 404 for /en-gb/ carries no Vary. This one does.
    // Recorded, not fixed -- for the same reason: a subtag that resolves is
    // a second URL for a page that already has one.
    for (const path of ["/english/", "/energy/needs/", "/en-gb/", "/ent/", "/enw/"]) {
      const r = await resolve(`https://www.givefood.org.uk${path}`);
      expect(r.lang).toBe("en");
      expect(r.pathAfterPrefix).toBe(path);
      expect(r.contentLanguage).toBe("en");
      expect(r.vary).toBe("Accept-Language");
    }
  });

  it("is case-sensitive", async () => {
    // Matching is exact Set membership over the lowercase LOCALES, so /CY/
    // is just another unrecognised segment. Pinned because a lowercasing
    // "tidy-up" would create a second URL for every Welsh page -- and
    // Cloudflare would cache both.
    const r = await resolve("https://www.givefood.org.uk/CY/needs/");
    expect(r.lang).toBe("en");
    expect(r.pathAfterPrefix).toBe("/CY/needs/");
    // /CY/ is an unrecognised segment, so negotiation "ran": Vary is
    // present, unlike the /cy/ row.
    expect(r.vary).toBe("Accept-Language");

    // The `bareEn` comparison is case-sensitive too, and this is the pair
    // that proves it: /en/ and /EN/ differ in the Vary column alone. A
    // `first.toLowerCase() === "en"` tidy-up would silently move /EN/ into
    // the /en/ row and change a cache key for a URL nobody tests by hand.
    const upper = await resolve("https://www.givefood.org.uk/EN/needs/");
    expect(upper.lang).toBe("en");
    expect(upper.pathAfterPrefix).toBe("/EN/needs/");
    expect(upper.vary).toBe("Accept-Language");
  });

  it("does not walk a subtag variant back to its base language", async () => {
    // A divergence from Django worth being explicit about rather than
    // discovering later. Django 6.1's get_supported_language_variant()
    // (django/utils/translation/trans_real.py) compares `code.lower()` and
    // walks "cy-gb" back through its "-" boundaries to "cy", so
    // get_language_from_path() recognises /cy-gb/ and /CY/ as Welsh. Both
    // still 404 there -- LocalePrefixPattern only ever matches the exact
    // "cy/" prefix -- but Django's 404 carries Content-Language: cy and no
    // Vary, where this one carries en and Vary: Accept-Language.
    //
    // Status codes agree; only the headers on a 404 differ, so this is
    // recorded, not fixed. Do not "correct" it by loosening the match: the
    // moment /cy-gb/ resolves to Welsh, every Welsh page has a second URL.
    for (const path of ["/cy-gb/", "/gd-scotland/needs/", "/GA/"]) {
      const r = await resolve(`https://www.givefood.org.uk${path}`);
      expect(r.lang).toBe("en");
      expect(r.pathAfterPrefix).toBe(path);
      // The comment above states the divergence as a header difference --
      // "Django's 404 carries Content-Language: cy and no Vary, where this
      // one carries en and Vary: Accept-Language" -- so assert both halves
      // of it. Without these two lines the claim is documentation only, and
      // the half that matters (Vary present ⇒ the edge keys this 404 on
      // Accept-Language) is exactly the half a loosened match would flip.
      expect(r.contentLanguage).toBe("en");
      expect(r.vary).toBe("Accept-Language");
    }
  });

  it("does not decode a percent-encoded prefix", async () => {
    // URL.pathname does not decode, so "%63y" stays "%63y" and never
    // reaches the prefix set. Worth pinning: if this middleware ever
    // decoded, /%63y/ would become a third spelling of every Welsh URL
    // and an easy way to multiply cache entries for one page.
    const r = await resolve("https://www.givefood.org.uk/%63y/needs/");
    expect(r.lang).toBe("en");
    expect(r.pathAfterPrefix).toBe("/%63y/needs/");
  });

  it("passes a non-ASCII first segment through in its encoded form", async () => {
    // The other half of "URL.pathname does not decode": it also does not
    // hand back what was typed. Welsh and Irish place names in this site's
    // slugs carry accents (Dún Laoghaire, Caerdydd's Cyfarthfa), so an
    // accented first segment is a realistic 404, and the middleware must
    // both survive it and hand the ENCODED path on -- pathAfterPrefix goes
    // straight into an href, where a raw "é" would be an invalid URL.
    const accented = await resolve("https://www.givefood.org.uk/café/needs/");
    expect(accented.lang).toBe("en");
    expect(accented.pathAfterPrefix).toBe("/caf%C3%A9/needs/");

    // Multi-byte, no ASCII at all: three characters become nine bytes, so
    // any implementation that measured the prefix in bytes rather than in
    // pathname characters would slice in the wrong place if this ever
    // matched. It must not throw, and it must not resolve to a language.
    const cjk = await resolve("https://www.givefood.org.uk/日本語/");
    expect(cjk.lang).toBe("en");
    expect(cjk.pathAfterPrefix).toBe("/%E6%97%A5%E6%9C%AC%E8%AA%9E/");
  });

  it("sees the URL-normalised path, so dot segments can change the answer", async () => {
    // Recorded because it is surprising, not because it is wanted: the
    // WHATWG URL parser resolves "." and ".." before this middleware ever
    // runs, so /gd/../cy/needs/ IS the Welsh needs page here, and
    // /cy/../en/ is an English 404 with no Vary. Worth pinning in both
    // directions: whichever way a future rewrite reads the path (c.req.path,
    // a raw string split, a regex on c.req.url), it must keep agreeing with
    // the normalisation the runtime and the edge cache already applied --
    // otherwise the language served and the URL cached disagree.
    const up = await resolve("https://www.givefood.org.uk/gd/../cy/needs/");
    expect(up.lang).toBe("cy");
    expect(up.pathAfterPrefix).toBe("/needs/");

    const down = await resolve("https://www.givefood.org.uk/cy/../en/");
    expect(down.lang).toBe("en");
    expect(down.pathAfterPrefix).toBe("/en/");
    expect(down.vary).toBeNull();
  });

  it("does not see a prefix behind a leading empty segment", async () => {
    // "//cy/" splits to ["", "", "cy", ""], so the first segment is empty.
    // Documenting the actual behaviour: a doubled slash is NOT a way to
    // reach the Welsh site, it is an English 404.
    const r = await resolve("https://www.givefood.org.uk//cy/needs/");
    expect(r.lang).toBe("en");
    expect(r.pathAfterPrefix).toBe("//cy/needs/");
  });

  it("treats the bare root as unprefixed rather than throwing", async () => {
    // "/" splits to ["", ""], so the first segment is the empty STRING --
    // not undefined, which is worth being precise about: the module's
    // `?? ""` guard is belt-and-braces that this input never reaches (an
    // http(s) URL's pathname always begins with "/", so split always yields
    // at least two elements). What actually protects the site's busiest URL
    // is that "" is not in PREFIXES and is not "en". Both branches therefore
    // take the unprefixed path, and the pathname is handed on intact.
    const r = await resolve("https://www.givefood.org.uk/");
    expect(r.lang).toBe("en");
    expect(r.pathAfterPrefix).toBe("/");
    // The empty first segment must not be treated as a match against an
    // empty-string member either -- if "" ever entered PREFIXES (an empty
    // entry in LOCALES, a stray filter) this would slice a character off
    // every unprefixed path on the site.
    expect(PREFIXES.has("")).toBe(false);
  });
});

describe("resolveLanguage: the path, not the URL", () => {
  it("ignores the query string when detecting and stripping the prefix", async () => {
    // /needs/ takes ?lat_lng= and the search pages take ?q=; a
    // substring-based implementation could easily let a query value that
    // contains "/cy/" change the language, or leak the query into
    // pathAfterPrefix and from there into every alternate-language <link>.
    const r = await resolve("https://www.givefood.org.uk/cy/needs/?lat_lng=51.5,-0.1&next=/gd/needs/");
    expect(r.lang).toBe("cy");
    expect(r.pathAfterPrefix).toBe("/needs/");
  });

  it("does not let a query string invent a prefix on an unprefixed path", async () => {
    const r = await resolve("https://www.givefood.org.uk/needs/?next=/cy/needs/");
    expect(r.lang).toBe("en");
    expect(r.pathAfterPrefix).toBe("/needs/");
  });

  it("returns an empty pathAfterPrefix for a slashless prefix-only path", async () => {
    // Boundary: "/cy" is the one input where the stripped path is "" rather
    // than something starting with "/". In production index.ts's
    // APPEND_SLASH fallback 301s /cy to /cy/ before any page renders, so
    // this value is short-lived -- but it IS what a handler would see, and
    // context.ts would build the English alternate as an empty href from it.
    // Recorded here as current behaviour, not endorsed.
    const r = await resolve("https://www.givefood.org.uk/cy");
    expect(r.lang).toBe("cy");
    expect(r.pathAfterPrefix).toBe("");
  });
});

// Every path here is one somebody has actually sent or a scanner soon will:
// empty segments, dot segments, an encoded prefix, a dropped Django
// language, a matrix parameter, an overlong segment. The expected language
// and Vary are written out as literals rather than recomputed from PREFIXES,
// because a test that re-derives the answer the same way the middleware does
// agrees with any bug the middleware has.
const PATH_TABLE: ReadonlyArray<{ path: string; lang: string; vary: string | null }> = [
  { path: "/", lang: "en", vary: "Accept-Language" },
  { path: "//", lang: "en", vary: "Accept-Language" },
  { path: "///", lang: "en", vary: "Accept-Language" },
  { path: "/needs/", lang: "en", vary: "Accept-Language" },
  { path: "/needs/at/sid-valley/", lang: "en", vary: "Accept-Language" },
  { path: "/cy", lang: "cy", vary: null },
  { path: "/cy/", lang: "cy", vary: null },
  { path: "/cy/needs/", lang: "cy", vary: null },
  { path: "/gd/needs/at/cy/", lang: "gd", vary: null },
  { path: "/en", lang: "en", vary: null },
  { path: "/en/", lang: "en", vary: null },
  { path: "/en/needs/", lang: "en", vary: null },
  // The three rows either side of the bareEn boundary: "en" exactly is the
  // only spelling that suppresses Vary, and a stem, a subtag or a different
  // case does not.
  { path: "/english/", lang: "en", vary: "Accept-Language" },
  { path: "/en-gb/", lang: "en", vary: "Accept-Language" },
  { path: "/EN/", lang: "en", vary: "Accept-Language" },
  { path: "/de/", lang: "en", vary: "Accept-Language" },
  { path: "/zh-hans/", lang: "en", vary: "Accept-Language" },
  { path: "//cy/", lang: "en", vary: "Accept-Language" },
  { path: "/CY/needs/", lang: "en", vary: "Accept-Language" },
  { path: "/cy-gb/", lang: "en", vary: "Accept-Language" },
  { path: "/cymru/", lang: "en", vary: "Accept-Language" },
  { path: "/%63y/", lang: "en", vary: "Accept-Language" },
  // An encoded slash cannot fake a segment boundary: URL.pathname leaves
  // %2F alone, so the first segment is the whole "cy%2Fneeds" and matches
  // nothing. A middleware that decoded before splitting would read this as
  // /cy/needs/ and serve Welsh from a URL the router will 404 -- language
  // and route disagreeing on the same request.
  { path: "/cy%2Fneeds/", lang: "en", vary: "Accept-Language" },
  { path: "/0/", lang: "en", vary: "Accept-Language" },
  { path: "/./", lang: "en", vary: "Accept-Language" },
  { path: "/café/needs/", lang: "en", vary: "Accept-Language" },
  { path: "/日本語/", lang: "en", vary: "Accept-Language" },
  { path: "/cy;jsessionid=1/", lang: "en", vary: "Accept-Language" },
  { path: `/${"a".repeat(2000)}/`, lang: "en", vary: "Accept-Language" },
];

describe("resolveLanguage: invariants that hold for every path", () => {
  it("resolves the whole table to the expected language and Vary", async () => {
    // The Vary rule stated as a rule rather than as six live-verified rows:
    // the header is present if and only if the first segment was neither a
    // registered prefix nor "en". Spelling out the odd inputs no header-table
    // row mentions ("//", "/0/", ";jsessionid", the 2000-character segment)
    // is the point -- those are where a rewrite loses track of which branch
    // it is in, and where a stray Vary quietly multiplies edge-cache entries
    // for one page. Content-Language is asserted alongside because the two
    // are one decision seen twice: the templates read the context variable,
    // caches read the header, and a page rendered in Welsh but labelled
    // English is worse than either being wrong alone.
    for (const row of PATH_TABLE) {
      const r = await resolve(`https://www.givefood.org.uk${row.path}`);
      expect({ path: row.path, lang: r.lang, vary: r.vary }).toEqual(row);
      expect(r.contentLanguage).toBe(row.lang);
    }
  });

  it("splits the path losslessly: prefix + pathAfterPrefix rebuilds it", async () => {
    // The property every individual pathAfterPrefix expectation above is one
    // example of, asserted across the whole table at once: whatever was
    // stripped, re-attaching it must give back exactly the pathname the
    // request arrived with. That is what makes context.ts's
    // `/${code}${unprefixedPath}` alternates round-trip to real URLs, and no
    // off-by-one in `slice(first.length + 1)` survives it on every input --
    // least of all the two with no slash to spare, "/cy" and "/".
    for (const row of PATH_TABLE) {
      const url = `https://www.givefood.org.uk${row.path}`;
      const r = await resolve(url);
      const rebuilt = (r.lang === "en" ? "" : `/${r.lang}`) + r.pathAfterPrefix;
      expect(rebuilt).toBe(new URL(url).pathname);
    }
  });

  it("only ever resolves to a language the app has a catalogue for", async () => {
    // `lang` goes straight to loadCatalogue/translate and into <html lang>,
    // with no validation anywhere downstream. A `const lang = first || "en"`
    // slip would ask for a catalogue named "cymru" and advertise an invented
    // language tag to every cache in the chain. Asserted against LOCALES
    // rather than a copied literal so a fifth language widens what is
    // allowed here without an edit.
    for (const row of PATH_TABLE) {
      const r = await resolve(`https://www.givefood.org.uk${row.path}`);
      expect(LOCALES).toContain(r.lang);
    }
  });
});

describe("resolveLanguage: PLAN.md §6.1.2 header table", () => {
  // The six live-verified production rows, adjusted only where PLAN.md
  // §2.7.1 deliberately changed the supported-language set. Each row asserts
  // status, Content-Language and the presence or absence of
  // Vary: Accept-Language together, because it is the combination that was
  // verified against production, and two of the rows differ from each other
  // in the Vary column alone.

  it("GET / with Accept-Language: pl -- 200, en, WITH Vary", async () => {
    const res = await siteLikeApp().request(
      "https://www.givefood.org.uk/",
      { headers: { "Accept-Language": "pl" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("GET /cy/ -- 200, cy, WITHOUT Vary", async () => {
    const res = await siteLikeApp().request("https://www.givefood.org.uk/cy/", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Language")).toBe("cy");
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("GET /ga/ and /gd/ -- 200, own language, WITHOUT Vary", async () => {
    for (const prefix of ["ga", "gd"]) {
      const res = await siteLikeApp().request(`https://www.givefood.org.uk/${prefix}/needs/`, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Language")).toBe(prefix);
      expect(res.headers.get("Vary")).toBeNull();
    }
  });

  it("GET /en/ -- 404, en, WITHOUT Vary", async () => {
    // The counter-intuitive row, and the reason `bareEn` exists as a
    // separate condition. LocalePrefixPattern emits an empty prefix for the
    // default language so /en/ matches no route -- but
    // get_language_from_path('/en/') still returns "en", so Django's
    // negotiation function never runs and never patches Vary.
    const res = await siteLikeApp().request("https://www.givefood.org.uk/en/", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("GET /cy/<no such page> -- 404, cy, WITHOUT Vary", async () => {
    // Not one of PLAN.md's six rows, but the commonest 404 the Welsh site
    // actually serves (a stale link, a closed foodbank's slug) and the only
    // 404 in the whole table that is NOT English. It matters because the
    // language is resolved from the path before routing, never from the
    // route that matched: render404 renders the Welsh 404 page, and the
    // edge stores it as one document for every visitor.
    //
    // A rewrite that moved language resolution into the router -- resolving
    // from the matched handler, or defaulting to "en" when nothing matched,
    // both of which read as tidier -- would 404 here in English while
    // passing every 200 test in this file, and Welsh visitors would get an
    // English error page at a Welsh URL.
    const res = await siteLikeApp().request("https://www.givefood.org.uk/cy/needs/at/no-such-foodbank/", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("cy");
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("GET /de/ -- 404, en, WITH Vary", async () => {
    // Byte-for-byte the same 404 body as /en/ above, and the same
    // Content-Language, differing only in this header. An implementation
    // that keyed Vary on "did a prefix match?" alone passes every other test
    // in this file and fails this pair.
    const res = await siteLikeApp().request("https://www.givefood.org.uk/de/", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("suppresses Vary for any path under /en/, not just the bare /en/", async () => {
    // bareEn is computed from the first path segment, so the whole /en/*
    // family behaves like the /en/ row -- which is right: Django's
    // get_language_from_path matches the prefix, not the whole path.
    const res = await siteLikeApp().request("https://www.givefood.org.uk/en/needs/at/sid-valley/", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("serves the 17 dropped languages as unrecognised segments (the §2.7.1 divergence)", async () => {
    // Django answered /zh-hans/ and /tlh/ with 200 and Content-Language:
    // zh-hans/tlh. This Worker ships 4 catalogues, so those URLs now take
    // the same path /de/ already took: English, 404, Vary present. The
    // module comment calls this "not a new code path, just a larger set of
    // inputs landing on the existing one" -- so assert they are
    // indistinguishable from /de/.
    for (const code of DROPPED_DJANGO_LANGUAGES) {
      const res = await siteLikeApp().request(`https://www.givefood.org.uk/${code}/`, {}, env);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Language")).toBe("en");
      expect(res.headers.get("Vary")).toBe("Accept-Language");
    }
  });
});

describe("resolveLanguage: how the headers are written", () => {
  it("appends to a Vary the handler already set instead of replacing it", async () => {
    // noStore.ts sets Vary: Cookie on every /admin and /auth response, and
    // those paths carry no language prefix -- so both middlewares write this
    // header on the same response. A plain c.header("Vary", ...) here would
    // drop the Cookie half and let the edge serve one visitor's admin page
    // to another.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", (c) => {
      c.header("Vary", "Cookie");
      return c.text("admin");
    });
    const res = await app.request("https://www.givefood.org.uk/admin/", {}, env);
    expect(res.headers.get("Vary")).toBe("Cookie, Accept-Language");
  });

  it("leaves a handler's Vary alone on a prefixed request", async () => {
    // The append is conditional, not unconditional-then-filtered: on /cy/
    // nothing is added, and crucially nothing already there is disturbed.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", (c) => {
      c.header("Vary", "Cookie");
      return c.text("page");
    });
    const res = await app.request("https://www.givefood.org.uk/cy/needs/", {}, env);
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("adds Accept-Language once when nothing else set Vary", async () => {
    // Appending is per-response, so a repeated value would be a caching
    // wart rather than an error -- invisible unless asserted.
    const res = await siteLikeApp().request("https://www.givefood.org.uk/de/", {}, env);
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("does NOT de-duplicate a Vary the handler already spelled Accept-Language", async () => {
    // Recorded, not endorsed. `{ append: true }` is Headers.append: it never
    // inspects what is already there, so a handler that set the same value
    // gets it twice. Nothing in the Worker does that today -- noStore.ts
    // appends Cookie, media.ts overwrites vary with accept-encoding -- but
    // media.ts also builds its headers with `new Headers(res.headers)` from
    // a subrequest, and its own comment documents that a Vary arriving that
    // way was "simply missed" once already. The duplicate is legal and
    // harmless per RFC 9110, but it is not what the "exactly once" test
    // above proves, so the real boundary is pinned here rather than assumed.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", (c) => {
      c.header("Vary", "Accept-Language");
      return c.text("page");
    });
    const res = await app.request("https://www.givefood.org.uk/needs/", {}, env);
    expect(res.headers.get("Vary")).toBe("Accept-Language, Accept-Language");
  });

  it("decorates a raw Response a handler returned, without disturbing its body", async () => {
    // media.ts, staticMedia.ts, api1.ts and whatsappHook.ts all return
    // `new Response(...)` directly rather than going through c.text/c.json,
    // and media.ts streams an R2 body it must never buffer. Hono implements
    // a post-next() c.header() on a finalised response by rebuilding the
    // Response around the same body -- twice here, once per header -- so
    // this asserts both halves of that: the headers land, and the bytes are
    // still readable afterwards. If either stopped being true, every image
    // on the site would lose its Content-Language or its body, and only in
    // production.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get(
      "*",
      () => new Response("PNGBYTES", { status: 200, headers: { "content-type": "image/png", vary: "accept-encoding" } }),
    );
    const res = await app.request("https://www.givefood.org.uk/media/foodbank/sid-valley.png", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Language")).toBe("en");
    // media.ts deliberately keeps accept-encoding and only that; the
    // language append must add to it rather than replace it, or the fix
    // recorded in media.ts's long `h.set("vary", ...)` comment is undone
    // from the other end of the chain.
    expect(res.headers.get("Vary")).toBe("accept-encoding, Accept-Language");
    expect(await res.text()).toBe("PNGBYTES");
  });

  it("decorates a bodyless 304 without turning it into a 200", async () => {
    // staticMedia.ts returns `new Response(null, { status: 304, ... })` on a
    // matching If-None-Match. Rebuilding a Response around a null body is
    // the case most likely to go wrong when a header is appended after the
    // fact -- 304 is a null-body status, so a rebuild that carried the
    // status across incorrectly would either throw or serve an empty 200 in
    // place of a conditional hit.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", () => new Response(null, { status: 304, headers: { etag: '"abc123"' } }));
    const res = await app.request("https://www.givefood.org.uk/static/css/main.css", {}, env);
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"abc123"');
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("overrides a Content-Language the handler set for itself", async () => {
    // Content-Language is part of the wire contract this middleware owns
    // (PLAN.md §6.1.2), and it is written after next() precisely so the
    // middleware, not a route, has the last word.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", (c) => {
      c.header("Content-Language", "fr");
      return c.text("page");
    });
    const res = await app.request("https://www.givefood.org.uk/gd/needs/", {}, env);
    expect(res.headers.get("Content-Language")).toBe("gd");
  });

  it("writes both headers on a redirect response", async () => {
    // slugRedirect (301) and several locale routes return redirects, and
    // resolveLanguage still has to decorate them -- a redirect that a
    // language-blind cache treats as universal is exactly the kind of bug
    // the Vary rule exists to prevent.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", (c) => c.redirect("/needs/at/county-durham/", 301));
    const res = await app.request("https://www.givefood.org.uk/needs/at/durham/", {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/needs/at/county-durham/");
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("decorates POSTs the same way it decorates GETs", async () => {
    // The /needs/at/:slug/updates/:action/ family is registered for POST as
    // well as GET. Nothing here inspects the method, and nothing should.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.post("*", (c) => c.text("subscribed"));
    const res = await app.request(
      "https://www.givefood.org.uk/cy/needs/at/sid-valley/updates/subscribe/",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Language")).toBe("cy");
    expect(res.headers.get("Vary")).toBeNull();
  });
});

describe("resolveLanguage: the error path", () => {
  it("still sets lang and pathAfterPrefix for a handler that throws", async () => {
    // render500.ts states this as a fact it depends on: "resolveLanguage is
    // global middleware ... so lang/pathAfterPrefix are already set on `c`
    // by the time an error thrown further down the chain reaches
    // app.onError -- same `c`, just caught higher up". If that stopped being
    // true, the 500 page would render with an undefined locale, i.e. the
    // one page guaranteed to be reached by an already-broken request would
    // break a second time.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", () => {
      throw new Error("D1 read failed");
    });
    let seen: { lang: string; pathAfterPrefix: string } | null = null;
    app.onError((_err, c) => {
      seen = { lang: c.get("lang"), pathAfterPrefix: c.get("pathAfterPrefix") };
      return c.html("<p>500</p>", 500);
    });
    const res = await app.request("https://www.givefood.org.uk/cy/needs/", {}, env);
    expect(res.status).toBe(500);
    expect(seen).toEqual({ lang: "cy", pathAfterPrefix: "/needs/" });
  });

  it("still writes the header contract onto a 500", async () => {
    // Hono runs onError inside the middleware chain rather than outside it,
    // so the post-next() half of this middleware DOES run for a failed
    // request and the 500 carries the same headers Django's
    // process_response would have patched onto it. Pinned because the
    // opposite -- an error page silently missing Content-Language/Vary --
    // would be entirely invisible in a diff.
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", () => {
      throw new Error("D1 read failed");
    });
    app.onError((_err, c) => c.html("<p>500</p>", 500));
    const res = await app.request("https://www.givefood.org.uk/needs/", {}, env);
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Language")).toBe("en");
    expect(res.headers.get("Vary")).toBe("Accept-Language");
  });

  it("runs the downstream handler exactly once", async () => {
    // A middleware that awaited next() twice, or forgot to await it, would
    // still produce a plausible-looking response; the double-render only
    // shows up as duplicated side effects (an extra D1 read, an extra
    // subscribe email) under load.
    let calls = 0;
    const app = new Hono<AppEnv>();
    app.use("*", resolveLanguage);
    app.get("*", (c) => {
      calls += 1;
      return c.text("page");
    });
    await app.request("https://www.givefood.org.uk/ga/needs/", {}, env);
    expect(calls).toBe(1);
  });
});
