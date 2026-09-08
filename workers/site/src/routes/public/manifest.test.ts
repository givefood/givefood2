import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";
import { manifestJson } from "./manifest";

// routes/public/manifest.ts -- manifestJson, the W3C web app manifest at
// /manifest.json and its three locale-prefixed registrations. Django's
// `manifest()` at givefood/views.py:849-900, read in full alongside this
// file (the dict below is transcribed from it line by line).
//
// WHY THIS FILE EXISTS. This handler has no database, no template and no
// branch, which makes it look like the least interesting route on the site
// and is precisely why it is worth pinning: every one of its failure modes
// is silent.
//
//   * The manifest is fetched by the BROWSER, not by a person. A malformed
//     or wrong-valued document produces no error page, no log line and no
//     drop in traffic -- the install prompt simply stops appearing, or the
//     installed app opens on the wrong URL, months before anyone notices.
//   * Its content is 100% literal, so the only mistakes possible are
//     transcription mistakes: one wrong screenshot dimension, a dropped
//     `purpose`, a Play Store id off by a character. All still valid JSON.
//   * The one thing that ISN'T literal is the pair of fields this port's
//     own header comment singles out -- `lang` and `description` -- and
//     getting those wrong means every locale serves an English manifest
//     with the right `Content-Language` header on it.
//   * `start_url` comes from a BINDING (c.env.SITE_DOMAIN). If that binding
//     ever goes missing the value is `undefined`, and JSON.stringify does
//     not throw or emit null for that -- it DELETES THE KEY. A manifest
//     with no start_url is a manifest whose installed app opens at whatever
//     URL happened to be current. Pinned below, because nothing else would
//     ever tell you.
//
// So the assertions here are on VALUES and on the exact serialised bytes,
// never on the status code.
//
// REAL EVERYTHING, the same harness as routes/public/flag.test.ts and
// routes/public/sitemaps.test.ts: the real production app (the default
// export of workers/site/src/index.ts), so the four route registrations,
// resolveLanguage, securityHeaders, cacheTag and pageCacheControl are the
// genuine articles, and the real .po-derived catalogues from
// @givefood/templates. NOTHING IS MOCKED AND NOTHING NEEDS TO BE: this
// route touches no D1, KV, R2 or queue binding, so `env()` below carries
// only SITE_DOMAIN and the two values other middleware reads. A binding
// appearing here in future is itself a signal worth noticing.
//
// MUTATION-TESTED in a copy of the repo outside it (never in place): 10
// deliberate breakages of manifest.ts -- start_url hardcoded instead of
// read from the binding, `lang` hardcoded to "en", translate() skipped,
// the msgid altered by one character, `purpose` dropped from the icon, a
// screenshot dimension changed by one pixel, two screenshots swapped,
// prefer_related_applications flipped, the Play Store id altered, and
// "; charset=utf-8" added to the Content-Type. All 10 were caught.

const ORIGIN = "https://www.givefood.org.uk";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Only what middleware on the path actually reads. No DB/KV/R2/queue: see
// the header comment -- their absence is deliberate evidence, not an
// oversight, and a NoSuchBinding TypeError is the failure this shape wants
// if the handler ever grows a query.
function env(overrides: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return {
    SITE_DOMAIN: ORIGIN,
    CSRF_SECRET: "test-csrf-secret-not-a-real-one",
    D1_DATABASE_NAME: "givefood-test",
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

const get = async (path: string, init?: RequestInit, bindings: AppEnv["Bindings"] = env()): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), bindings, execCtx);

// The msgid passed to translate(), which is also what an English request
// gets back: loadCatalogue("en") returns {} (i18n.ts:25), so translate()
// falls through to the msgid itself. Written out here rather than imported
// so that changing the string in the source is a visible test failure and
// not a silently agreed-on rename -- this exact text is the one in
// givefood/views.py:861 and in the msgid at locale/*/LC_MESSAGES/django.po.
const MSGID = "Use Give Food's tool to find what food banks near you are requesting to have donated";

// The three msgstrs, read out of the Django repo's own catalogues
// (/Users/jasoncartwright/Sites/foodcharity/locale/<lang>/LC_MESSAGES/django.po,
// the entry marked `#: givefood/views.py:736`) rather than copied from the
// port's generated JSON -- otherwise this would only be testing that a file
// equals itself. They match packages/templates/src/generated/locales/*.json
// exactly, which is the parity claim worth making: the port's catalogues
// carry Django's translations, not new ones.
const TRANSLATED: Record<string, string> = {
  cy: "Defnyddiwch offeryn Give Food i ddarganfod pa fanciau bwyd yn eich ardal chi y mae'n gofyn iddynt fod wedi'u rhoi",
  ga: "Bain úsáid as uirlis Give Food chun a fháil amach cé na bainc bia in aice leat atá ag iarraidh go ndéanfaí deontas orthu",
  gd: "Cleachd inneal Give Food gus faighinn a-mach dè na bancaichean bìdh faisg ort a tha ag iarraidh a thoirt seachad",
};

// givefood/views.py:857-897, transcribed field by field. This is the
// reference the port is being checked against, so it is written from the
// Python source and NOT derived from manifest.ts -- a copy of the module's
// own literal would agree with any mutation of it.
function djangoManifest(description: string, lang: string, startUrl: string = ORIGIN) {
  return {
    name: "Give Food",
    short_name: "Give Food",
    description,
    start_url: startUrl,
    display: "minimal-ui",
    lang,
    icons: [
      {
        src: "/static/img/favicon.svg",
        sizes: "48x48 72x72 96x96 128x128 256x256 512x512",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
    screenshots: [
      { src: "/static/img/manifestscreens/index.png", type: "image/png", sizes: "1402x2356" },
      { src: "/static/img/manifestscreens/search.png", type: "image/png", sizes: "1402x2356" },
      { src: "/static/img/manifestscreens/foodbank.png", type: "image/png", sizes: "1402x2356" },
    ],
    prefer_related_applications: true,
    related_applications: [
      {
        platform: "play",
        url: "https://play.google.com/store/apps/details?id=uk.org.givefood.android",
        id: "uk.org.givefood.android",
      },
    ],
  };
}

// The exact bytes served at /manifest.json, as a literal rather than as
// JSON.stringify(djangoManifest(...)) -- the module under test IS a
// JSON.stringify call, so building the expectation with the same serialiser
// would agree with any reordering or whitespace change it made. A literal
// pins key order and separators too.
const EN_BODY = `{"name":"Give Food","short_name":"Give Food","description":"${MSGID}","start_url":"${ORIGIN}","display":"minimal-ui","lang":"en","icons":[{"src":"/static/img/favicon.svg","sizes":"48x48 72x72 96x96 128x128 256x256 512x512","type":"image/svg+xml","purpose":"any"}],"screenshots":[{"src":"/static/img/manifestscreens/index.png","type":"image/png","sizes":"1402x2356"},{"src":"/static/img/manifestscreens/search.png","type":"image/png","sizes":"1402x2356"},{"src":"/static/img/manifestscreens/foodbank.png","type":"image/png","sizes":"1402x2356"}],"prefer_related_applications":true,"related_applications":[{"platform":"play","url":"https://play.google.com/store/apps/details?id=uk.org.givefood.android","id":"uk.org.givefood.android"}]}`;

describe("GET /manifest.json -- the document itself", () => {
  it("serves the exact bytes, in Django's key order", async () => {
    // THE TEST THIS FILE EXISTS FOR. Everything in this document is a
    // literal, so a byte comparison is the only assertion that catches a
    // one-character transcription slip in a Play Store id, a screenshot
    // dimension or an icon path -- each of which stays valid JSON, keeps
    // the 200, and quietly breaks installation or the store listing link.
    //
    // TWO KNOWN, DELIBERATE DIVERGENCES FROM DJANGO'S BYTES, both from
    // JSON.stringify vs json.dumps and both semantically invisible once
    // parsed (checked by running python3 3.13.0 on this machine, not
    // assumed):
    //   * separators. json.dumps defaults to ", " and ": ", so Django's
    //     body was `{"name": "Give Food", ...}`. JSON.stringify emits no
    //     spaces at all.
    //   * ensure_ascii. json.dumps defaults to True, so the ga/gd
    //     descriptions went out as úsáid escapes; this port emits
    //     raw UTF-8 (see the locale block below).
    // Neither changes the parsed document, which is what a browser reads.
    const res = await get("/manifest.json");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EN_BODY);
  });

  it("parses to exactly Django's dict, with no key added or missing", async () => {
    // The same document again, compared structurally against the dict
    // transcribed from views.py. Kept alongside the byte test because a
    // failure here reads as a diff of two objects, which is what tells you
    // WHICH field drifted; the byte test tells you that something did.
    const parsed = JSON.parse(await (await get("/manifest.json")).text());

    expect(parsed).toEqual(djangoManifest(MSGID, "en"));
    // toEqual would pass if the port emitted the keys in a different order
    // -- irrelevant to a browser, but it is also how a hand-edit that
    // duplicates and shadows a field shows up.
    expect(Object.keys(parsed)).toEqual([
      "name",
      "short_name",
      "description",
      "start_url",
      "display",
      "lang",
      "icons",
      "screenshots",
      "prefer_related_applications",
      "related_applications",
    ]);
  });

  it("is served as application/json with no charset, as Django's HttpResponse was", async () => {
    // views.py:899 passes content_type="application/json" verbatim, and
    // Django sends exactly that string. A `; charset=utf-8` suffix would be
    // harmless here but is not what the original sent, and this is the only
    // header the handler itself sets -- so it is the only one whose value
    // is this module's own decision rather than a middleware's.
    const res = await get("/manifest.json");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("the two fields that vary by language", () => {
  // manifest.ts's header comment claims only `lang` and `description` vary
  // by language. These four tests are that claim, written down.

  it.each(["cy", "ga", "gd"])("serves /%s/manifest.json in that language", async (locale) => {
    // A locale that renders the ENGLISH description with the right `lang`
    // is the failure worth catching: the document is still valid, the
    // header still says cy, and an installed Welsh app describes itself in
    // English. That is what a dropped translate() call, or a msgid that no
    // longer matches the catalogue key, produces.
    const res = await get(`/${locale}/manifest.json`);
    const parsed = JSON.parse(await res.text());

    expect(res.status).toBe(200);
    expect(parsed.lang).toBe(locale);
    expect(parsed.description).toBe(TRANSLATED[locale]);
    expect(parsed.description).not.toBe(MSGID);
    // resolveLanguage's own contract, asserted here because a manifest
    // whose `lang` and Content-Language disagree is the specific
    // inconsistency a browser will believe the header half of.
    expect(res.headers.get("Content-Language")).toBe(locale);
  });

  it("emits the ga/gd accented characters as raw UTF-8 and reads them back intact", async () => {
    // The half of the ensure_ascii divergence that could actually bite: a
    // manifest served as raw UTF-8 with no charset parameter (see above) is
    // read as UTF-8 by the JSON spec's own default, but only if the bytes
    // really are UTF-8. A mis-encoded body would show up as mojibake in the
    // install prompt and nowhere else.
    const ga = await (await get("/ga/manifest.json")).text();
    expect(ga).toContain("Bain úsáid as uirlis Give Food");
    expect(ga).not.toContain("\\u00fa");
    expect(JSON.parse(ga).description).toBe(TRANSLATED.ga);
  });

  it("falls back to the English msgid, not to an empty string, with no catalogue", async () => {
    // loadCatalogue("en") returns {} rather than an English catalogue, so
    // the English description is produced by translate()'s fallback path.
    // If that fallback ever became "" the manifest would still be valid
    // JSON with an empty description -- pinned so it cannot.
    const parsed = JSON.parse(await (await get("/manifest.json")).text());
    expect(parsed.description).toBe(MSGID);
    expect(parsed.lang).toBe("en");
  });

  it("differs between the four locales ONLY in lang and description", async () => {
    // The module's own claim, and the one that catches a field being made
    // locale-dependent by accident -- a translated screenshot path, a
    // locale-prefixed start_url. Comparing whole documents with the two
    // known-variable fields removed is a much wider net than checking the
    // fields that are supposed to change.
    const documents = await Promise.all(
      ["/manifest.json", "/cy/manifest.json", "/ga/manifest.json", "/gd/manifest.json"].map(async (path) => {
        const { lang: _lang, description: _description, ...rest } = JSON.parse(await (await get(path)).text());
        return rest;
      }),
    );

    for (const document of documents) expect(document).toEqual(documents[0]);
    // And the invariant part is not empty -- eight of the ten keys.
    expect(Object.keys(documents[0])).toHaveLength(8);
  });

  it("ignores Accept-Language and a language cookie entirely", async () => {
    // PLAN.md §3.5's rule 1, restated at the top of
    // middleware/resolveLanguage.ts: the URL path prefix wins and is the
    // ONLY thing that ever wins. Django computed a language from the
    // session, the cookie and Accept-Language and then discarded it. Adding
    // content negotiation here would fragment the edge cache for a document
    // every single visitor fetches.
    const res = await get("/manifest.json", {
      headers: { "Accept-Language": "cy-GB,cy;q=0.9", Cookie: "django_language=cy" },
    });

    expect(JSON.parse(await res.text()).lang).toBe("en");
    expect(res.headers.get("Content-Language")).toBe("en");
  });
});

describe("start_url comes from the SITE_DOMAIN binding", () => {
  it("uses whatever the binding says, not a baked-in domain", async () => {
    // wrangler.jsonc:177 sets SITE_DOMAIN = "https://www.givefood.org.uk",
    // which is also this suite's ORIGIN -- so a hardcoded literal in the
    // handler would pass every other test in this file. Serving one request
    // with a different binding value is the only thing that separates the
    // two, and it matters because a preview deployment whose manifest
    // start_url points at production installs the wrong app.
    const res = await get("/manifest.json", undefined, env({ SITE_DOMAIN: "https://beta.example.invalid" }));

    expect(JSON.parse(await res.text()).start_url).toBe("https://beta.example.invalid");
  });

  it("SILENTLY DROPS start_url when the binding is missing", async () => {
    // SUSPECT, pinned rather than fixed (see this file's header). With no
    // SITE_DOMAIN the value is `undefined`, and JSON.stringify omits
    // undefined-valued keys instead of throwing or writing null: the
    // response is a 200 carrying a well-formed manifest that has no
    // start_url at all, so an installed app opens at whatever URL it was
    // installed from. wrangler.jsonc always sets the var, so this is a
    // latent trap rather than a live bug -- but it is exactly the class of
    // silent failure this route cannot report.
    const body = await (await get("/manifest.json", undefined, env({ SITE_DOMAIN: undefined }))).text();

    expect(body).not.toContain("start_url");
    expect(Object.keys(JSON.parse(body))).toHaveLength(9);
    // Everything else still renders, which is what makes it invisible.
    expect(JSON.parse(body).name).toBe("Give Food");
  });
});

describe("how the manifest is served", () => {
  it("carries NO Cache-Control at all, unlike Django's @cache_page(SECONDS_IN_DAY)", async () => {
    // SUSPECT, pinned rather than fixed. givefood/views.py:849 decorates
    // manifest() with @cache_page(SECONDS_IN_DAY), so Django sent a
    // max-age. This port sends nothing: the handler sets no header, and
    // middleware/pageCacheControl.ts's CACHEABLE_TYPES covers only
    // text/html, application/rss+xml and text/markdown, so an
    // application/json response falls straight through its gap-filler.
    // Whatever the zone's Cache Rule does at the edge, every browser
    // re-fetches this document. Asserting the absence rather than "fixing"
    // it, per this repo's convention -- but it is a real divergence from
    // the Django source the file cites.
    const res = await get("/manifest.json");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("mints no cookie and no Vary, so the edge may share one copy", async () => {
    // The manifest is fetched by every visitor's browser and is identical
    // for all of them. A Set-Cookie (Cloudflare refuses to cache those) or
    // a Vary added by a future middleware would quietly make it per-visitor
    // -- the exact failure routes/public/flag.test.ts documents for /flag/.
    const res = await get("/manifest.json");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    // cacheTag.ts's AGGREGATE_PATHS matches /sitemap*.xml but not
    // /manifest.json, so this response is untagged and cannot be purged by
    // queues/cachePurge.ts. Correct -- its content depends on no row in the
    // database -- and pinned so a widened tag rule is a deliberate act.
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  it("returns byte-identical documents to two different requests", async () => {
    // No timestamp, no request id, no per-visitor field: the whole document
    // is a pure function of (locale, SITE_DOMAIN). This is the property
    // that makes it safe for a shared cache, and it is cheap to lose --
    // debugcomment.njk's clock is in every HTML page on the site for
    // exactly that reason, and this route deliberately renders no template.
    const first = await (await get("/manifest.json")).text();
    const second = await (await get("/manifest.json")).text();
    expect(second).toBe(first);
  });

  it("answers HEAD with the same headers and no body", async () => {
    // Not decoration: lib/appendSlash.ts probes with HEAD to decide whether
    // to 301, so HEAD behaviour on a real route is load-bearing routing
    // machinery here, not just protocol politeness.
    const res = await get("/manifest.json", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe("");
  });

  it("404s a POST, where Django's path() would have answered it", async () => {
    // A DIVERGENCE, pinned. Django's urls.py:52 puts no method restriction
    // on manifest(), so a POST to /manifest.json rendered the same JSON
    // with a 200; index.ts registers app.get only, so Hono has no matching
    // route and it reaches app.notFound(). Nothing posts to a manifest, so
    // this is noted rather than mourned -- but it is a difference, and
    // writing it down is cheaper than rediscovering it from a log.
    const res = await get("/manifest.json", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("the URLs that reach this handler", () => {
  it("serves all four of Django's i18n_patterns registrations", async () => {
    // givefood/urls.py:52 sits inside i18n_patterns, so Django exposed the
    // manifest under every configured language prefix. index.ts:485-491
    // reproduces that for the four locales this port keeps. A missing
    // locale registration is a 404 on a URL page.njk's <link rel="manifest">
    // never points at -- so it would only ever be found by a Welsh user
    // trying to install the app.
    for (const path of ["/manifest.json", "/cy/manifest.json", "/ga/manifest.json", "/gd/manifest.json"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toBe("application/json");
    }
  });

  it("404s /en/manifest.json, because en is never a prefix", async () => {
    // resolveLanguage.ts: "en" is deliberately NOT in PREFIXES
    // (prefix_default_language=False in Django), and /en/ 404s in
    // production today. If a fifth registration were ever added in a loop
    // that forgot the `if (locale === "en") continue` guard, this is what
    // would catch it.
    const res = await get("/en/manifest.json");

    expect(res.status).toBe(404);
    // The 404 PAGE, not a JSON body -- i.e. it fell through to
    // app.notFound() rather than reaching this handler with lang "en".
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  it("404s one of Django's other 17 languages", async () => {
    // PLAN.md §2.7.1: this port serves 4 languages, not Django's 21. A
    // /pl/ request has no matching prefix, so resolveLanguage falls to
    // "en" and no route matches the path -- the same treatment production's
    // own unconfigured /de/ already got.
    const res = await get("/pl/manifest.json");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en");
  });

  it("301s the legacy /needs/manifest.json to the root one, unprefixed from every locale", async () => {
    // gfwfbn/urls/i18n.py:14, a RedirectView with permanent=True (hence the
    // 301 where index.ts's other redirects are 302s), pointing at the
    // literal string "/manifest.json" -- so even the locale variants land
    // on the UNPREFIXED root manifest, because RedirectView does no
    // locale-aware reversing. Nothing generates these URLs, but a PWA
    // installed against the old one still asks for it, and an install that
    // 404s on its manifest is an install that silently stops updating.
    for (const path of ["/needs/manifest.json", "/cy/needs/manifest.json", "/ga/needs/manifest.json", "/gd/needs/manifest.json"]) {
      const res = await get(path);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("Location"), path).toBe("/manifest.json");
    }
  });
});

// ---------------------------------------------------------------------------
// manifestJson OUTSIDE the router.
//
// index.ts only ever mounts this handler on the four paths above, so
// `lang` can only ever be one of LOCALES -- which is why the
// `c.get("lang") as Locale` cast in the source is safe today. It is a CAST,
// though: `Vars["lang"]` is typed `string`, so TypeScript checks nothing
// here, and the guarantee lives entirely in index.ts's registration loop.
//
// This is NOT a second copy of the router and asserts nothing about
// routing (every routing assertion above uses the real app). It mounts the
// REAL exported handler on a deliberately looser path to execute a state
// the real paths forbid, so that the day someone reuses this handler
// somewhere less constrained, the current behaviour is written down rather
// than discovered in production. Same device, and same reasoning, as
// routes/public/country.test.ts's guardHarness.
// ---------------------------------------------------------------------------
let thrown: unknown = null;

const guardHarness = new Hono<AppEnv>();
guardHarness.get("/:lang/manifest.json", async (c) => {
  c.set("lang", c.req.param("lang"));
  try {
    return await manifestJson(c);
  } catch (err) {
    thrown = err;
    return c.text("threw", 500);
  }
});

describe("manifestJson with a locale the router cannot produce", () => {
  it("throws instead of falling back to English", async () => {
    // i18n.ts's loadCatalogue indexes a LOADERS table that has entries for
    // cy/ga/gd only, so an unknown locale is `LOADERS[locale]()` on
    // undefined -- observed here as TypeError "LOADERS[locale] is not a
    // function" (message not asserted: it is V8's phrasing, not a contract).
    // Through the real app that would reach index.ts's app.onError and
    // render a 500 page. No fallback to the msgid, and no partial manifest.
    thrown = null;
    const res = await guardHarness.fetch(new Request(`${ORIGIN}/de/manifest.json`), env(), execCtx);

    expect(res.status).toBe(500);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  it("still builds the document when the locale IS one of the four", async () => {
    // The harness's own control: proves the test above failed on the
    // locale and not on the harness -- an exception thrown for some other
    // reason would otherwise look like the pinned behaviour.
    thrown = null;
    const res = await guardHarness.fetch(new Request(`${ORIGIN}/gd/manifest.json`), env(), execCtx);

    expect(res.status).toBe(200);
    expect(thrown).toBeNull();
    expect(JSON.parse(await res.text())).toEqual(djangoManifest(TRANSLATED.gd!, "gd"));
  });
});
