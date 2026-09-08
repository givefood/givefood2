import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_SQL as SCHEMA } from "@givefood/db/src/schema.testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";

// routes/public/contentPages.ts -- the three static root-app pages:
// publicAboutUs (GET /about-us/, Django's about_us() at givefood/views.py:594),
// publicApps (GET /apps/, apps() at :1023) and publicBot (GET /bot/, bot() at
// :1012). All three are registered bare and under /cy/, /ga/ and /gd/
// (index.ts:418-440), matching givefood/urls.py's i18n_patterns block.
//
// WHY THIS FILE EXISTS. "Static page" is the reason nobody looks at these
// again, and it is wrong in three ways that all render a perfectly good-looking
// 200:
//
//   * THE LOCALE IS AN ARGUMENT, not a property of the page. Each handler
//     reads c.get("lang"), passes it to buildPageContext AND to render(), and
//     passes c.get("pathAfterPrefix") separately so the hreflang alternates and
//     the language switcher can be rebuilt for the other three languages. Drop
//     any one of those three and the page still renders: drop the render()
//     locale and /cy/about-us/ silently serves English under <html lang="cy">;
//     drop unprefixedPath and every alternate URL doubles its prefix
//     (/cy/cy/about-us/), which Google follows and indexes as a 404.
//   * THE BOT PAGE IS AN INTERFACE. Its one variable is the crawler's literal
//     User-Agent, and its readers are food bank webmasters copying that string
//     into an allowlist or a robots.txt. A character wrong there does not break
//     the page, it breaks the crawl -- silently, in someone else's config.
//   * THESE ARE THE LONGEST-CACHED HTML PAGES ON THE SITE. /about-us/ and
//     /bot/ get s-maxage=604800 from middleware/pageCacheControl.ts and carry
//     no Cache-Tag, so anything per-visitor that reaches the body is served to
//     everyone for up to a week with no way to purge it. That is not
//     hypothetical here: pageCacheControl.ts records reproducing exactly that
//     on production with a CSRF token on /flag/, and routes/public/flag.test.ts
//     is the suite written against it.
//
// So the assertions are the RENDERED VALUES -- titles, the translated body, the
// four alternate URLs, the user-agent string -- plus the two properties that
// make the pages safe to cache for a week (no query, no cookie, same bytes for
// two different visitors). A status code assertion would pass under every one
// of the failures above.
//
// REAL EVERYTHING, the same harness as routes/apiDocs.test.ts and
// routes/public/md.test.ts: the real production app (workers/site/src/index.ts's
// default export), so the real router, the real middleware chain in its real
// order, and the real locale registrations; the real Nunjucks environment and
// the real compiled .po catalogues. The D1 binding is real in-memory SQLite
// built from the real migrations -- not because these handlers query (they must
// not, and that is asserted) but so that a query which CREEPS IN executes for
// real and fails the assertion on the recorded SQL, rather than exploding
// against a stub and hiding behind a 500. Only global fetch is faked, and only
// to prove nothing here leaves the machine.
//
// MUTATION-TESTED (TESTING.md's convention) in a copy of the whole tree in a
// scratchpad outside the repo -- never by editing a file in src/ and putting it
// back. 25 mutants, every one of them failed this file. Widened well past
// contentPages.ts, because these handlers are six lines each and almost
// everything that can go wrong on these pages lives somewhere else:
// index.ts's route table, middleware/pageCacheControl.ts, cacheTag.ts and
// resolveLanguage.ts, packages/templates' i18n.ts and blocktransExtension.ts,
// and the three .njk files (re-running the precompile step, without which a
// .njk edit is inert and the "mutant" proves nothing -- the first attempt at
// the three template mutants survived for exactly that reason, because the lab
// copy's workspace links still resolved @givefood/templates back to the real
// repo). The kills worth naming, each being a test's reason to exist: each
// handler rendering one of the other two's templates; pageTranslatable turned
// off; unprefixedPath replaced by c.req.path and separately dropped; the
// locale withheld from render() and from buildPageContext; BOT_USER_AGENT's
// version bumped, its leading "+" removed, and the whole variable dropped from
// the context; render_time_ms dropped; canonical built from the unprefixed
// path; /apps/ removed from index.ts's locale loop; /bot/ pointed at
// publicApps; "apps" added to WEEKLY_PAGES and the weekly rule deleted
// outright; the content pages added to cacheTag's aggregate purge set;
// app.get swapped for app.all; resolveLanguage keeping the prefix in
// pathAfterPrefix; translate() ignoring the catalogue; blocktrans returning a
// plain string instead of a SafeString; the language switcher removed from
// about_us.njk and added to apps.njk; one app screenshot deleted; and -- the
// one a "static page" suite would never otherwise catch -- a single D1 read
// added to publicApps.
//
// Parity checked by reading Django, not by assuming: about_us/bot carry
// @cache_page(SECONDS_IN_WEEK) and apps @cache_page(SECONDS_IN_DAY)
// (givefood/views.py:592, 1010, 1021; givefood/const/cache_times.py:5-6), and
// BOT_USER_AGENT is byte-identical to givefood/const/general.py:210. Django's
// own about_us.html includes the language switcher while apps.html and bot.html
// do not -- also checked, because this port reproduces that asymmetry and it
// reads like an omission.

const ORIGIN = "https://www.givefood.org.uk";

// middleware/runtimeIdentity.ts turns CF_VERSION_METADATA.id into `version`
// (first 8 characters), which page.njk cache-busts every stylesheet with. Fixed
// here so `?v=` is an assertable value rather than the "unknown" fallback -- the
// about-us page is the only one of the three with a stylesheet of its own, and
// that link is how a wrong-template render shows up.
const VERSION_ID = "abcd1234-0000-4000-8000-000000000000";
const VERSION = "abcd1234";

// givefood/const/general.py:210, character for character. Written out here as a
// literal rather than imported (the constant is module-private to
// contentPages.ts, and importing it would compare the page to itself): this
// string's whole purpose is that it matches, on the wire, what GiveFoodBot
// actually sends, so the test's copy has to come from the Python source.
const BOT_USER_AGENT = "Mozilla/5.0 (compatible; GiveFoodBot/1.0; +https://www.givefood.org.uk/bot/)";

type Bindable = null | number | bigint | string | Uint8Array;

// The slice of the D1 Sessions API packages/db uses, over node:sqlite, with
// every prepared statement recorded. `prepared` is the point: "the page still
// renders" is true with or without a database read, so the only way to pin
// "these three handlers touch no database at all" is to look at the statements.
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

// One database for the whole file, not one per test: nothing here writes to it,
// and applying every migration is the expensive part. `prepared` is what has to
// be per-test, and that is reset below.
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
  // Records any subrequest and refuses it loudly. A page whose whole value is
  // that it renders from nothing must not grow a fetch to an app store, a
  // GitHub API or an analytics endpoint -- and if one appears, the failure
  // should name it rather than show up as a slow test.
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
// context built without one throws there, turning what should be a 301 into a
// 500. (Observed while writing this file, using Hono's app.request() helper.)
const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env(), execCtx);

const body = async (path: string): Promise<string> => (await get(path)).text();

// includes/debugcomment.njk stamps a wall-clock timestamp and a render duration
// into every page. Both legitimately differ between two responses and neither is
// per-VISITOR, so they are the only thing normalised before a byte comparison --
// and this asserts it actually found both, so a template change that removes
// them cannot quietly turn the comparison into a comparison of nothing.
function withoutClockNoise(html: string): string {
  expect(html).toMatch(/🕰️ Generated at .+/);
  expect(html).toMatch(/⏱️ Took \d+ms/);
  return html.replace(/🕰️ Generated at .+/, "🕰️ Generated at <T>").replace(/⏱️ Took \d+ms/, "⏱️ Took <N>ms");
}

// The four `<link rel="alternate" hreflang=...>` page.njk emits from
// `languages`, in order. Parsed into "code|href" pairs so a failure names the
// language and the URL rather than handing over a slab of markup.
function alternates(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hreflang="([a-z]+)" href="([^"]+)">/g)].map((m) => `${m[1]}|${m[2]}`);
}

// The language switcher's own links (includes/langswitcher.njk). A DIFFERENT
// rendering of the same `languages` list from the hreflang tags above, which is
// why both are asserted: about_us.njk includes the switcher and the other two
// pages do not, so the two lists disagreeing is a real possible state.
function switcherLinks(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]+)" class="dropdown-item">/g)].map((m) => m[1] ?? "");
}

// ---------------------------------------------------------------------------
// publicAboutUs -- GET /about-us/
// ---------------------------------------------------------------------------

describe("publicAboutUs -- GET /about-us/", () => {
  // WHICH TEMPLATE RENDERED. All three handlers in this file are the same six
  // lines with one string changed, so "renders a page" is satisfied by any of
  // them rendering any of the others' templates. These four values exist only
  // in public/about_us.njk: its title, its h1, the stylesheet its own
  // {% block head %} adds (cache-busted with `version`, which is why
  // CF_VERSION_METADATA is fixed above), and its meta description.
  it("renders about_us.njk -- its title, heading, own stylesheet and meta description", async () => {
    const res = await get("/about-us/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>About us - Give Food</title>");
    expect(html).toContain("<h1>About us</h1>");
    expect(html).toContain(`<link rel="stylesheet" href="/static/css/about_us.css?v=${VERSION}">`);
    expect(html).toContain(
      '<meta name="description" content="Give Food a UK charity uses data to highlight local and structural food insecurity then provides tools to help alleviate it.">',
    );
  });

  // buildPageContext({ path: c.req.path }) -- canonical is the request's own
  // path, matching context_processors.py:17-19 (SITE_DOMAIN + translate_url).
  it("declares itself canonical at its own URL", async () => {
    expect(await body("/about-us/")).toContain(`<link rel="canonical" href="${ORIGIN}/about-us/">`);
  });

  // pageTranslatable: true is what makes page.njk emit these at all, and
  // buildPageContext only builds the `languages` list when it is given a locale.
  // Both are arguments this handler passes, and losing either drops all four
  // alternates from a page that exists in four languages -- invisible to a
  // reader, immediately visible to a search engine.
  it("advertises all four languages, English unprefixed, in LOCALES order", async () => {
    const html = await body("/about-us/");

    expect(alternates(html)).toEqual([
      `en|${ORIGIN}/about-us/`,
      `cy|${ORIGIN}/cy/about-us/`,
      `ga|${ORIGIN}/ga/about-us/`,
      `gd|${ORIGIN}/gd/about-us/`,
    ]);
  });

  // The switcher is the human-facing half of the same list, and about_us.njk is
  // the ONLY one of these three templates that includes it -- verified against
  // Django, whose about_us.html:17 includes langswitcher.html while apps.html
  // and bot.html do not. Pinned on both sides (see the apps/bot suites below)
  // so the asymmetry stays a decision rather than becoming a bug report.
  it("renders the language switcher, with a relative link per language", async () => {
    const html = await body("/about-us/");

    expect(switcherLinks(html)).toEqual(["/about-us/", "/cy/about-us/", "/ga/about-us/", "/gd/about-us/"]);
  });

  // THE ONE ARGUMENT THAT ONLY MATTERS UNDER A PREFIX. Both the alternate URLs
  // and the switcher are built from `unprefixedPath` (c.get("pathAfterPrefix")),
  // not from the request path. Hand buildPageContext c.req.path instead -- the
  // obvious simplification, since the two are identical in English -- and every
  // link on the Welsh page becomes /cy/cy/about-us/, /ga/cy/about-us/ and so on.
  // The page renders identically; only the links are wrong.
  it("strips the locale prefix exactly once when building the alternates", async () => {
    const html = await body("/cy/about-us/");

    expect(alternates(html)).toEqual([
      `en|${ORIGIN}/about-us/`,
      `cy|${ORIGIN}/cy/about-us/`,
      `ga|${ORIGIN}/ga/about-us/`,
      `gd|${ORIGIN}/gd/about-us/`,
    ]);
    expect(switcherLinks(html)).toEqual(["/about-us/", "/cy/about-us/", "/ga/about-us/", "/gd/about-us/"]);
    expect(html).not.toContain("/cy/cy/");
  });

  // THE LOCALE REACHING render(). buildPageContext's locale sets <html lang>
  // and the switcher; render()'s locale is a SEPARATE argument and is what
  // loads the .po catalogue. Drop only the second and this page comes back
  // fully English underneath a `lang="cy"` root element -- valid HTML, wrong
  // page, and nothing in a status code or a link check would notice.
  //
  // Three strings, deliberately from three different mechanisms: the title is
  // `{{ _("About us") }}`, the timeline entry is a plain `_()` and the body is
  // a `{% blocktrans %}` block resolved by BlocktransExtension.
  it("renders Welsh from the real catalogue at /cy/about-us/, not English under lang=cy", async () => {
    const html = await body("/cy/about-us/");

    expect(html).toContain('<html lang="cy" dir="ltr"');
    expect(html).toContain("<title>Amdanom ni - Give Food</title>");
    expect(html).toContain("<h1>Amdanom ni</h1>");
    expect(html).toContain("<dd>Dosbarthiadau bwyd prawf cyntaf i fanciau bwyd</dd>");
    expect(html).toContain("Mae Give Food yn elusen yn y DU");
    // And the English it replaced is gone -- a catalogue merged in on top of
    // the source strings rather than instead of them would pass every
    // assertion above.
    expect(html).not.toContain("<h1>About us</h1>");
  });

  // BLOCKTRANS RETURNS HTML, and packages/templates wraps it in a SafeString
  // for exactly this reason: the translated paragraph contains real anchors to
  // /needs/, /write/ and the Charity Commission. Autoescape it and the visitor
  // reads the tags instead of following them -- on the charity's own about
  // page, in Welsh only, where nobody who ships it is likely to look.
  it("leaves the translated body's links as markup rather than escaping them", async () => {
    const html = await body("/cy/about-us/");

    expect(html).toContain('<a href="/needs/">gronfa ddata gyhoeddus genedlaethol o fanciau bwyd</a>');
    expect(html).not.toContain("&lt;a href=");
  });

  // url('index') is injected per render() call with the request's locale (see
  // env.ts), so the logo link on a prefixed page must stay inside that
  // language. A locale-blind url() sends every Welsh reader who clicks the logo
  // back to the English home page.
  it("keeps the logo link inside the current language", async () => {
    expect(await body("/about-us/")).toContain('<a href="/" class="logo">');
    expect(await body("/gd/about-us/")).toContain('<a href="/gd/" class="logo">');
  });

  // Django's @cache_page(SECONDS_IN_WEEK) (givefood/views.py:592), reproduced by
  // middleware/pageCacheControl.ts's WEEKLY_PAGES rule rather than by this
  // handler -- which is why it is asserted here: nothing in contentPages.ts
  // mentions caching, so the number is only ever checked at the page.
  // max-age=300 rather than Django's 86400 is that middleware's documented,
  // deliberate divergence (the edge can be purged, a browser cache cannot).
  it("is cached for a week at the edge and five minutes in the browser", async () => {
    const res = await get("/about-us/");

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    // Not one of middleware/noStore.ts's mounts, so none of its headers.
    expect(res.headers.get("CDN-Cache-Control")).toBeNull();
  });

  // Content-Language is resolveLanguage's post-response contract, and the only
  // header on the page that varies by locale. `Vary: Accept-Language` must NOT
  // come back with it -- removed 2026-09-07 (issue #39) because it minted a
  // separate edge object per Accept-Language string for identical bytes, and
  // this is one of the two pages held at the edge for a full week.
  it("labels the language in a header and adds no Accept-Language Vary", async () => {
    const en = await get("/about-us/");
    const ga = await get("/ga/about-us/");

    expect(en.headers.get("Content-Language")).toBe("en");
    expect(ga.headers.get("Content-Language")).toBe("ga");
    expect(en.headers.get("Vary")).toBeNull();
  });

  // A DIVERGENCE, PINNED. context_processors.py:38-40 and :46-48 appended
  // QUERY_STRING to both flag_path and every alternate URL, so Django's
  // "Something wrong in this page?" link and its language switcher carried the
  // query the reader was actually looking at. These handlers pass only `path`
  // to buildPageContext, so the query is dropped. Harmless here (nothing on
  // these pages reads a parameter) and recorded so it is a known difference
  // rather than a surprise -- the same note routes/apiDocs.test.ts makes.
  it("drops the query string from the flag link and the alternates, unlike Django", async () => {
    const html = await body("/about-us/?utm_source=newsletter");

    expect(html).toContain(`href="/flag/#${ORIGIN}/about-us/"`);
    expect(html).not.toContain("utm_source");
  });

  // The debug comment's "Took Nms" is elapsedMs(c) reading the timestamp
  // middleware/serverTiming.ts stored -- whole milliseconds, deliberately not
  // Django's three decimals, because performance.now() only advances at I/O
  // boundaries on Workers and the fraction was always exactly ".000". Drop
  // render_time_ms from the context and the line reads "Took ms".
  it("reports a whole-millisecond render time in the debug comment", async () => {
    expect(await body("/about-us/")).toMatch(/⏱️ Took \d+ms\n/);
  });
});

// ---------------------------------------------------------------------------
// publicApps -- GET /apps/
// ---------------------------------------------------------------------------

describe("publicApps -- GET /apps/", () => {
  it("renders apps.njk -- its title, heading and the four store screenshots", async () => {
    const res = await get("/apps/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>Give Food Apps</title>");
    expect(html).toContain("<h1>Give Food Apps</h1>");
    // The page's actual substance: the two store badges and the four
    // screenshots. /static/img/appscreenshots/** is one of the two families
    // excluded from Workers Static Assets and served by routes/staticMedia.ts
    // (index.ts:218), so these paths are a live contract with another route,
    // not decoration.
    expect(html).toContain('<a href="https://apps.apple.com/gb/app/give-food/id6755759247">');
    expect(html).toContain('<a href="https://play.google.com/store/apps/details?id=uk.org.givefood.android">');
    expect(html.match(/<img src="\/static\/img\/appscreenshots\/\d\.png"/g)).toHaveLength(4);
  });

  // THE DIFFERENT NUMBER. /apps/ is the one page of the three Django cached for
  // a DAY rather than a week (@cache_page(SECONDS_IN_DAY), givefood/views.py:1021),
  // and pageCacheControl.ts reproduces that by simply leaving "apps" out of its
  // WEEKLY_PAGES list so it lands on the SECONDS_IN_DAY fallthrough. Both halves
  // are asserted in one test because the failure worth catching is someone
  // "tidying" the list by adding apps to it: /apps/ alone would still look
  // right, and the page would go stale seven times longer than Django's.
  it("gets a day where about-us and bot get a week, matching Django's own decorators", async () => {
    expect((await get("/apps/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=86400");
    expect((await get("/about-us/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
    expect((await get("/bot/")).headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=604800");
  });

  // pageTranslatable is true here too, so the alternates are emitted -- but
  // apps.njk has no {% include "includes/langswitcher.njk" %}, matching Django's
  // apps.html, so the page offers a reader no way to reach them. Asserted in
  // both directions: a well-meaning "fix" that adds the include is a template
  // change with no ticket behind it, and dropping pageTranslatable to "match
  // the missing switcher" would delete four correct hreflang tags.
  it("advertises four languages in the head while offering no switcher in the body", async () => {
    const html = await body("/apps/");

    expect(alternates(html)).toEqual([
      `en|${ORIGIN}/apps/`,
      `cy|${ORIGIN}/cy/apps/`,
      `ga|${ORIGIN}/ga/apps/`,
      `gd|${ORIGIN}/gd/apps/`,
    ]);
    expect(html).not.toContain("langswitcher");
  });

  // PINNED, AND WORTH KNOWING. apps.njk contains no {% trans %} or
  // {% blocktrans %} at all, so /ga/apps/ serves an English body inside Irish
  // page chrome -- the footer, the flag link and the nav come from page.njk and
  // ARE translated. That is what the port ships and what Django shipped
  // (apps.html has no translation tags either); asserting the wish would leave
  // the suite red and tell nobody. The two halves are asserted together so the
  // page cannot quietly become uniformly English (a lost render() locale) or
  // uniformly Irish (a translated apps.njk nobody reviewed).
  it("serves an English body inside translated chrome under a locale prefix", async () => {
    const res = await get("/ga/apps/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="ga" dir="ltr"');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/ga/apps/">`);
    // Body: still English, still the source strings.
    expect(html).toContain("<h1>Give Food Apps</h1>");
    // Chrome: Irish, from the real catalogue, with locale-prefixed links.
    expect(html).toContain('<li><a href="/ga/">Baile</a></li>');
    expect(html).toContain('<li><a href="/ga/apps/">Aipeanna</a></li>');
    expect(html).toContain('<a href="/ga/" class="logo">');
  });
});

// ---------------------------------------------------------------------------
// publicBot -- GET /bot/
// ---------------------------------------------------------------------------

describe("publicBot -- GET /bot/", () => {
  it("renders bot.njk -- its title and heading", async () => {
    const res = await get("/bot/");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");

    const html = await res.text();
    expect(html).toContain("<title>GiveFoodBot - Give Food</title>");
    expect(html).toContain("<h1>GiveFoodBot</h1>");
  });

  // THE PAGE'S ONE VARIABLE, AND THE REASON THIS HANDLER IS NOT THE OTHER TWO.
  // BOT_USER_AGENT is the string the crawler really sends, and this page exists
  // so a food bank's webmaster can paste it into an allowlist. Asserted as the
  // whole <code> element: a value dropped from the context renders
  // `<code></code>` (nunjucks' throwOnUndefined is off, deliberately), which is
  // a 200 with an empty line where the interface used to be.
  it("prints the crawler's exact User-Agent, byte for byte with the Python constant", async () => {
    const html = await body("/bot/");

    expect(html).toContain(`<code>${BOT_USER_AGENT}</code>`);
    // Once, and only in the <code> block -- so a stray second copy that drifts
    // from the first cannot appear without failing here.
    expect(html.match(/Mozilla\/5\.0/g)).toHaveLength(1);
  });

  // THE STRING IS SELF-REFERENTIAL: its `+https://...` component is the URL of
  // this very page, which is how a webmaster who sees the agent in their logs
  // gets here. Derived from the page's own canonical rather than hardcoded, so
  // moving the page (or the constant) without moving the other fails.
  it("points at this page from inside the user agent, at the URL this page claims", async () => {
    const html = await body("/bot/");
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];

    expect(canonical).toBe(`${ORIGIN}/bot/`);
    expect(html).toContain(`+${canonical})</code>`);
  });

  // A USER AGENT IS NOT PROSE, and this is the page's one translatable-looking
  // string that must never be translated: the value is a machine token pasted
  // into somebody else's allowlist. contentPages.ts passes it as a context
  // variable rather than through _(), so the risk is not a bad translation of
  // it but a well-meant one being added -- which shows up only in the locale
  // where it was added. Hence all four locales, not just English.
  //
  // Deliberately NOT asserting "unescaped": the string contains none of the
  // five characters nunjucks escapes (& < > " '), so an autoescape regression
  // is invisible here and a test claiming to catch one would be decoration.
  // The template's own {{ }} is the right place for that, if it is ever needed.
  it("prints the same user agent in every locale, translated by none of them", async () => {
    for (const path of ["/bot/", "/cy/bot/", "/ga/bot/", "/gd/bot/"]) {
      const html = await body(path);
      expect(html, path).toContain(`<code>${BOT_USER_AGENT}</code>`);
    }
  });

  // Same asymmetry as /apps/: alternates in the head, no switcher in the body,
  // matching Django's bot.html.
  it("advertises four languages in the head while offering no switcher in the body", async () => {
    const html = await body("/bot/");

    expect(alternates(html)).toEqual([
      `en|${ORIGIN}/bot/`,
      `cy|${ORIGIN}/cy/bot/`,
      `ga|${ORIGIN}/ga/bot/`,
      `gd|${ORIGIN}/gd/bot/`,
    ]);
    expect(html).not.toContain("langswitcher");
  });
});

// ---------------------------------------------------------------------------
// All three -- the properties that make them safe to cache, and the routing
// ---------------------------------------------------------------------------

const PAGES = ["/about-us/", "/apps/", "/bot/"] as const;
const PREFIXES = ["", "/cy", "/ga", "/gd"] as const;

describe("all three content pages", () => {
  // THE CLAIM IN THE MODULE'S OWN HEADER -- "no DB queries" -- and the one
  // property of a static page that can regress without changing a pixel. A
  // read added here costs a D1 round trip on three of the site's
  // longest-cached pages and, on a D1 outage, converts them from "always
  // available" to "500". Asserted on the statements that actually reached the
  // engine, across all four locales, because a query added inside a
  // locale-dependent branch would hide from an English-only check.
  it("issue no database query and make no subrequest, in any locale", async () => {
    for (const prefix of PREFIXES) {
      for (const page of PAGES) {
        prepared = [];
        outbound = [];
        const res = await get(`${prefix}${page}`);

        expect(res.status, `${prefix}${page}`).toBe(200);
        expect(prepared, `${prefix}${page}`).toEqual([]);
        expect(outbound, `${prefix}${page}`).toEqual([]);
      }
    }
  });

  // THE INVARIANT THAT MAKES A WEEK OF SHARED CACHE SAFE: two different
  // visitors get the same bytes. Written as a property rather than as a list of
  // things that must not appear, because the failure mode is open-ended -- a
  // CSRF token, a session-derived greeting, a geo lookup, an echoed header --
  // and every one of them would be served to everybody once the first visitor
  // populated the edge. This is the exact incident middleware/pageCacheControl.ts
  // reproduced on production with /flag/ in September 2026.
  it("serve byte-identical bodies to two different visitors", async () => {
    for (const page of PAGES) {
      const anonymous = await body(page);
      const identified = await (
        await get(page, {
          Cookie: "__Host-csrf=deadbeef; sessionid=012345",
          "Accept-Language": "cy,en-GB;q=0.8",
          "User-Agent": "Mozilla/5.0 (some other browser)",
        })
      ).text();

      expect(withoutClockNoise(identified), page).toBe(withoutClockNoise(anonymous));
    }
  });

  // No cookie, for the same reason: Cloudflare refuses to cache a response
  // carrying Set-Cookie, so one appearing here would silently drop three pages
  // out of the edge cache entirely (a BYPASS on every request) rather than
  // breaking anything visible.
  it("set no cookie", async () => {
    for (const page of PAGES) {
      expect((await get(page)).headers.get("Set-Cookie"), page).toBeNull();
    }
  });

  // NO CACHE-TAG, AND THAT IS CORRECT. middleware/cacheTag.ts tags a response
  // with what it depends on so queues/cachePurge.ts can invalidate it; these
  // three pages depend on no food bank and no constituency, so they get none
  // and nothing purges them. Pinned because the consequence is severe in one
  // direction and wasteful in the other: content edited into these templates is
  // invisible for up to a week (a deploy is what publishes it), while adding
  // AGGREGATE_TAG here would drag three unchanging pages into every food bank
  // save's purge.
  it("carry no cache tag, so nothing but a deploy replaces them", async () => {
    for (const page of PAGES) {
      expect((await get(page)).headers.get("Cache-Tag"), page).toBeNull();
    }
  });

  // The i18n_patterns registration, all twelve URLs. index.ts builds the three
  // prefixed forms in a loop over LOCALES; a page left out of that loop 404s in
  // three languages while its own hreflang tags (asserted above) go on
  // advertising them -- the pair of failures that produces indexed 404s.
  it("are live at all twelve locale URLs, each canonical to itself", async () => {
    for (const prefix of PREFIXES) {
      for (const page of PAGES) {
        const path = `${prefix}${page}`;
        const res = await get(path);

        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toContain(`<link rel="canonical" href="${ORIGIN}${path}">`);
      }
    }
  });

  // prefix_default_language=False: "en" is a real language with no URL prefix,
  // so /en/about-us/ is not a page. /de/ is one of the 17 languages §2.7.1
  // dropped and takes the same path. Both must 404 rather than redirect or
  // render, and neither may be rescued by the trailing-slash probe.
  it("404 under an unregistered language prefix, including /en/", async () => {
    for (const page of PAGES) {
      expect((await get(`/en${page}`)).status, `/en${page}`).toBe(404);
      expect((await get(`/de${page}`)).status, `/de${page}`).toBe(404);
    }
  });

  // Django's APPEND_SLASH, via lib/appendSlash.ts -- a 301 to the slashed URL,
  // not a rewrite. Worth pinning for these three specifically because the probe
  // re-enters the app with a HEAD request and needs the route to answer
  // something other than 404/501; a page dropped from the router turns this
  // into a 404 rather than into a redirect loop, which is easy to misread.
  it("301 a missing trailing slash to the slashed URL", async () => {
    for (const page of PAGES) {
      const res = await get(page.replace(/\/$/, ""));

      expect(res.status, page).toBe(301);
      expect(res.headers.get("Location"), page).toBe(`${ORIGIN}${page}`);
    }
  });

  // A DIVERGENCE, PINNED. Django's three views carry no method decorator, so a
  // POST to any of them renders the page with a 200. index.ts registers them
  // with app.get(), so Hono never matches and app.notFound() answers -- 404,
  // with the real 404 page. Nothing POSTs to a content page, and the port's
  // answer is arguably the better one; it is recorded here so it is a known
  // difference rather than a discovery.
  it("404 a POST, where Django's undecorated views rendered the page", async () => {
    for (const page of PAGES) {
      const res = await app.fetch(new Request(`${ORIGIN}${page}`, { method: "POST" }), env(), execCtx);

      expect(res.status, page).toBe(404);
      expect(await res.text(), page).toContain("<h1>404 - Not Found</h1>");
    }
  });
});
