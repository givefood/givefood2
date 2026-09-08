import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../../index";
import type { AppEnv } from "../../types";
import { robotsTxt } from "./robots";

// routes/public/robots.ts -- robotsTxt, the /robots.txt served at the root
// and under the three locale prefixes. Django's `robotstxt()` at
// givefood/views.py:818-846 plus its template
// givefood/templates/public/robots.txt, both read in full alongside this
// file (byte-dumped, not rendered -- see PROVENANCE below).
//
// WHY THIS FILE EXISTS. robots.txt is read by machines that never complain.
// Every failure mode of this handler is silent, and several of them are
// silent in the expensive direction:
//
//   * A Disallow line that gains a locale prefix it should not have, or
//     loses one it should, does not 404 and does not log. It either stops
//     protecting a URL (Googlebot starts hammering /needs/getlocation/,
//     which geocodes) or starts blocking one it should not.
//   * A Sitemap: line pointing at a URL that 404s is how a sitemap quietly
//     stops being read. This module's own header comment records
//     md_sitemap having been omitted for exactly that reason ("don't
//     advertise a URL that 501s") and then added back once /md/ existed --
//     so the pairing of "advertised" with "actually routed" is a property
//     this file has already got wrong once, and is asserted below against
//     the REAL router's registration table rather than by eye.
//   * The domain on every Sitemap: line comes from a BINDING
//     (c.env.SITE_DOMAIN). Unlike manifest.json, where a missing binding
//     deletes the key, here it interpolates the literal text "undefined"
//     into a URL. Pinned below, because a crawler is the only party that
//     would ever see it.
//   * Nothing about the response varies by request, so a body that
//     accidentally became per-visitor (a timestamp, a cookie, a Vary) would
//     be cached by the edge for the week this handler asks for and served
//     to everyone.
//
// So the assertions are on the exact bytes and on individual VALUES, never
// on the status code.
//
// PROVENANCE. The Django comparison here is read from source on this
// machine -- givefood/views.py:818-846 and the template, whose bytes were
// dumped with od(1) to settle the whitespace questions -- and NOT from a
// rendered Django response. Django was not run; no claim below says it was.
//
// REAL EVERYTHING, the same harness as routes/public/manifest.test.ts and
// routes/public/flag.test.ts: the real production app (the default export
// of workers/site/src/index.ts), so the four route registrations,
// serverTiming, securityHeaders, cacheTag, runtimeIdentity, slugRedirect,
// resolveLanguage and pageCacheControl are all the genuine articles, and
// the real @givefood/urls reverse tables behind urlForLocale(). NOTHING IS
// MOCKED AND NOTHING NEEDS TO BE: this route touches no D1, KV, R2 or queue
// binding (slugRedirect's SLUG_PATTERN cannot match /robots.txt), so env()
// below carries only SITE_DOMAIN and the two values other middleware reads.
// A binding appearing here in future is itself a signal worth noticing.
//
// MUTATION-TESTED in a copy of the repo outside it (never in place): 15
// deliberate breakages, all 15 caught.
//
// Twelve in robots.ts and its reverse tables -- packages/urls' `en` guard
// dropped so /en/ prefixes appear; the md_sitemap push moved inside the
// locale loop; the two Disallow pushes swapped; "wfbn:get_location" changed
// to "wfbn:index"; the per-locale sitemap push dropped; the blank line
// between the two User-agent groups removed; the trailing newline dropped;
// Crawl-delay changed to 1; the Cache-Control header dropped; a charset
// added to the Content-Type; "/at/*/hit/" quietly "corrected" to
// "/needs/at/*/hit/"; and c.env.SITE_DOMAIN replaced by the same domain
// hardcoded (which every whole-body assertion still accepts -- only the
// binding tests below catch it, which is why they exist).
//
// Three in index.ts, the ones the whole-body assertion CANNOT see because
// the body would still be correct: the /md/sitemap.xml route deleted while
// robots.txt kept advertising it, and the /cy/ (and so /ga/, /gd/)
// robots.txt registration dropped. Each was caught by exactly one test --
// the two that read the real router's registration table rather than a
// response body.

const ORIGIN = "https://www.givefood.org.uk";

const execCtx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

// Only what middleware on the path actually reads. No DB/KV/R2/queue: see
// the header comment -- their absence is deliberate evidence, not an
// oversight.
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

// The exact bytes served at /robots.txt, written as one literal rather than
// assembled from LOCALES or from url()/urlForLocale(). The module under
// test IS a loop over LOCALES joined with "\n", so building the expectation
// the same way would agree with any reordering, any lost locale and any
// wrong route name it produced. The domain is spelled out rather than
// interpolated from ORIGIN for the same reason -- it is wrangler.jsonc:177's
// value, checked there, not this file's own constant reflected back.
//
// The STRUCTURE (User-agent, the Disallow block, a blank line, the second
// User-agent group, a blank line, the Sitemap block, trailing newline) is
// the Django template's structure exactly: "User-agent: *", then
// "\nDisallow: {{ url }}" per entry, then "\n\nUser-agent: *\nAllow:
// /\nCrawl-delay: 2\n\n", then "Sitemap: {{ domain }}{{ url }}\n" per entry.
// The template ends immediately after that loop with no trailing whitespace
// (od(1) on the 300-byte file), which is what the port's `join("\n") + "\n"`
// also produces.
const EXPECTED_BODY = `User-agent: *
Disallow: /aac/
Disallow: /at/*/hit/
Disallow: /needs/getlocation/
Disallow: /flag/
Disallow: /cy/needs/getlocation/
Disallow: /cy/flag/
Disallow: /ga/needs/getlocation/
Disallow: /ga/flag/
Disallow: /gd/needs/getlocation/
Disallow: /gd/flag/

User-agent: *
Allow: /
Crawl-delay: 2

Sitemap: https://www.givefood.org.uk/sitemap.xml
Sitemap: https://www.givefood.org.uk/cy/sitemap.xml
Sitemap: https://www.givefood.org.uk/ga/sitemap.xml
Sitemap: https://www.givefood.org.uk/gd/sitemap.xml
Sitemap: https://www.givefood.org.uk/md/sitemap.xml
`;

const linesOf = (body: string): string[] => body.split("\n");
const startingWith = (body: string, prefix: string): string[] => linesOf(body).filter((line) => line.startsWith(prefix));

describe("GET /robots.txt -- the document itself", () => {
  it("serves the exact bytes, in Django's order and shape", async () => {
    // THE TEST THIS FILE EXISTS FOR. Every line here is either a literal or
    // a reverse-resolved path, so the only mistakes possible are ones that
    // still produce a valid, 200-status robots.txt: a locale prefix on the
    // wrong line, a route name that resolves to a different page, an entry
    // emitted four times instead of once. A whole-body comparison is the
    // only assertion that catches those, and it fails with a readable diff
    // saying which line moved.
    const res = await get("/robots.txt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPECTED_BODY);
  });

  it("emits 21 lines and a trailing newline -- 10 Disallow, 5 Sitemap", async () => {
    // The counts stated in robots.ts's own header comment ("Disallow: is 10
    // lines here, not Django's 44"), written down so that adding a fifth
    // locale to LOCALES is a visible, deliberate change to this file rather
    // than something noticed later in Search Console. The trailing-newline
    // check is separate because `join("\n")` without the `+ "\n"` leaves a
    // final line with no terminator, which some robots.txt parsers drop --
    // and that final line is the /md/ sitemap.
    const body = await (await get("/robots.txt")).text();
    const lines = linesOf(body);

    expect(lines).toHaveLength(22); // 21 lines + the empty string after the final "\n"
    expect(lines[21]).toBe("");
    expect(body.endsWith("\n")).toBe(true);
    expect(startingWith(body, "Disallow: ")).toHaveLength(10);
    expect(startingWith(body, "Sitemap: ")).toHaveLength(5);
    expect(startingWith(body, "User-agent: ")).toHaveLength(2);
  });

  it("keeps the two User-agent groups separated by a blank line", async () => {
    // Django's template has the blank lines; a robots.txt where the second
    // "User-agent: *" is not preceded by a blank line puts Allow: / and
    // Crawl-delay: 2 in the same record as the Disallow list for some
    // parsers and starts a new record for others. Reproduced verbatim
    // rather than tidied, because "tidying" it is a behaviour change to a
    // file whose whole audience is other people's parsers.
    const lines = linesOf(await (await get("/robots.txt")).text());

    expect(lines[0]).toBe("User-agent: *");
    expect(lines[11]).toBe("");
    expect(lines[12]).toBe("User-agent: *");
    expect(lines[13]).toBe("Allow: /");
    expect(lines[14]).toBe("Crawl-delay: 2");
    expect(lines[15]).toBe("");
  });

  it("is pure ASCII, so the missing charset on the Content-Type cannot matter", async () => {
    // The response declares "text/plain" with no charset (next test). That
    // is only safe while the body stays ASCII: a food bank name or a
    // translated path with a non-ASCII byte would be decoded by whatever
    // default a given crawler picks. Nothing here is derived from the
    // database today -- this assertion is what would notice if that changed.
    const body = await (await get("/robots.txt")).text();
    expect(/^[\x20-\x7e\n]*$/.test(body)).toBe(true);
  });

  it("is served as bare text/plain, with no charset parameter", async () => {
    // views.py:846 passes content_type='text/plain' to render(). The
    // handler sets the same string here, and it is one of only two headers
    // this module chooses for itself -- everything else on the response
    // belongs to a middleware. A "; charset=utf-8" suffix would be harmless
    // but is not what the original sent, and llms.txt in the sibling
    // textFiles.ts DOES send the suffix, so the two are easy to conflate.
    const res = await get("/robots.txt");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("sets its own week-long Cache-Control, which pageCacheControl must not touch", async () => {
    // The other header this module owns. Django had
    // @cache_page(SECONDS_IN_WEEK) on robotstxt() (views.py:817), and
    // 604800 is that week. It is set HERE rather than left to
    // middleware/pageCacheControl.ts because that middleware deliberately
    // stopped treating text/plain as cacheable -- text/plain is the type
    // most likely to be a per-visitor fragment, and it had been stamping
    // /frag/ip-address/ public (that file records serving a stranger's IPv6
    // address from cache on 2026-09-07). So this route is opted in by hand,
    // and pageCacheControl's "never override" guard is what keeps both
    // facts true at once. If the guard regressed, the value below would
    // become the middleware's `public, max-age=300, s-maxage=...` instead.
    const res = await get("/robots.txt");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800");
  });
});

describe("what is deliberately NOT in the file", () => {
  // Absences, asserted explicitly. A robots.txt is a list, and every bug
  // this handler can have that a whole-body test would catch is also a bug
  // an extra line would introduce -- these name the specific extra lines
  // that have a reason to appear.

  it("never emits an /en/ prefix, on any line", async () => {
    // urlForLocale() returns the unprefixed path for "en"
    // (packages/urls/src/index.ts:37), matching Django's
    // prefix_default_language=False. If that guard were dropped, this file
    // would advertise /en/sitemap.xml and disallow /en/flag/ -- URLs that
    // 404 on this site today (middleware/resolveLanguage.ts: "en" is
    // deliberately NOT in PREFIXES). A crawler told to fetch a sitemap that
    // 404s reports the sitemap as broken, and nothing here would say why.
    const body = await (await get("/robots.txt")).text();
    expect(body).not.toContain("/en/");
  });

  it("advertises no sitemap_places index, permanently", async () => {
    // Django's loop pushed BOTH reverse("sitemap") and
    // reverse("sitemap_places_index") per language (views.py:836-837), so
    // its list was 42 entries plus md_sitemap. This port omits the places
    // half entirely -- maintainer decision 2026-08-31 recorded in robots.ts:
    // the /needs/at/place/ gazetteer pages are out of scope, so there is no
    // sitemap to advertise. Asserted as an absence so that re-adding it
    // (easy to do while "restoring parity") has to be deliberate: the URL
    // would 404 here.
    const body = await (await get("/robots.txt")).text();

    expect(body).not.toContain("sitemap_places");
    expect(body).not.toContain("sitemap_external");
  });

  it("carries none of Django's other 17 language prefixes", async () => {
    // views.py:834 loops `for language in LANGUAGES`, and settings.py:233
    // lists 21 of them (en, pl, cy, bn, ro, pa, ur, ar, gu, es, pt, gd, ga,
    // it, ta, fr, lt, zh-hans, tr, bg, tlh). This port serves 4 (PLAN.md
    // §2.7.1), so a /pl/sitemap.xml line would advertise a 404 -- the same
    // failure the /en/ test above describes, from the opposite direction.
    const body = await (await get("/robots.txt")).text();

    for (const prefix of ["/pl/", "/bn/", "/ro/", "/pa/", "/ur/", "/ar/", "/gu/", "/es/", "/pt/", "/it/", "/ta/", "/fr/", "/lt/", "/zh-hans/", "/tr/", "/bg/", "/tlh/"]) {
      expect(body, prefix).not.toContain(prefix);
    }
  });

  it("does NOT disallow /admin/ or /auth/, matching Django", async () => {
    // Pinned, not proposed. Django's disallowed_urls list is exactly
    // ["/aac/", "/at/*/hit/"] plus the two per-language entries
    // (views.py:832-838) -- the admin was never in it, in either app. The
    // admin is protected by requireAdminAuth and marked private/no-store by
    // middleware/noStore.ts, which is the protection that actually works; a
    // robots.txt entry would only publish the path. Written down so that
    // its absence reads as inherited rather than forgotten.
    const body = await (await get("/robots.txt")).text();

    expect(body).not.toContain("Disallow: /admin");
    expect(body).not.toContain("Disallow: /auth");
  });

  it("omits Django's debugcomment banner entirely -- an undocumented divergence", async () => {
    // DIVERGENCE, pinned. Django's template's first line is
    // `{% include 'public/includes/debugcomment.html' with inrobotstxt=True %}`,
    // and that include has an `{% if inrobotstxt %}#{% endif %}` on every
    // line: the served robots.txt began with a "#"-commented greeting, the
    // instance id, the code version, the render time and a 20-line ASCII-art
    // logo. This port renders no template and emits none of it, which
    // robots.ts's own header comment does not mention.
    //
    // Nothing consumes those comment lines (RFC 9309 parsers skip "#"), so
    // this is noted rather than mourned -- but it is also the reason the
    // body below is a pure function of (SITE_DOMAIN) and therefore safely
    // cacheable for the week the handler asks for. Django's version carried
    // a wall-clock render time in it and was still cached for a week.
    const body = await (await get("/robots.txt")).text();

    expect(body).not.toContain("#");
    expect(body.startsWith("User-agent: *")).toBe(true);
  });
});

describe("the URLs this file points at are URLs the router actually serves", () => {
  // Hono keeps its registration table on `app.routes`, so the real router's
  // wiring can be looked at directly rather than by firing a request at
  // every advertised path (most of which need D1 and would only prove that
  // a fixture was seeded). This is the check robots.ts's header comment
  // implies but nothing enforced: md_sitemap was once left out of the
  // Sitemap: list precisely because advertising a URL that 501s is worse
  // than advertising nothing, and it has since been added back.
  const registered = (method: string, path: string): boolean =>
    app.routes.some((route) => route.method === method && route.path === path);

  it("registers a GET handler for all five advertised sitemaps", async () => {
    const body = await (await get("/robots.txt")).text();
    const paths = startingWith(body, "Sitemap: ").map((line) => line.slice(`Sitemap: ${ORIGIN}`.length));

    expect(paths).toEqual(["/sitemap.xml", "/cy/sitemap.xml", "/ga/sitemap.xml", "/gd/sitemap.xml", "/md/sitemap.xml"]);
    for (const path of paths) expect(registered("GET", path), path).toBe(true);
  });

  it("registers a handler for every Disallow path except the wildcard one", async () => {
    // The disallowed paths are the ones a crawler is being asked NOT to
    // fetch, which makes a wrong one invisible twice over: no 404 appears
    // in the logs because nobody fetches it, and the page that should have
    // been protected keeps being crawled. /needs/getlocation/ geocodes
    // through the MapIt/Google path, so it is the one that costs money.
    for (const path of ["/aac/", "/needs/getlocation/", "/cy/needs/getlocation/", "/ga/needs/getlocation/", "/gd/needs/getlocation/", "/flag/", "/cy/flag/", "/ga/flag/", "/gd/flag/"]) {
      expect(registered("GET", path), path).toBe(true);
    }
  });

  it("SUSPECT: `Disallow: /at/*/hit/` matches no path this site has ever served", async () => {
    // Pinned, not fixed -- and inherited, not introduced. Django's
    // views.py:832 hardcodes the string "/at/*/hit/", but the hit endpoint
    // is registered under the /needs/ prefix in both apps
    // (gfwfbn/urls/generic.py:9 gives /needs/at/<slug>/hit/, and index.ts:375
    // registers the same path here). robots.txt paths are matched from the
    // start of the path, so a rule for /at/... can never match /needs/at/...
    // -- the line has been decorative in production for as long as it has
    // existed.
    //
    // Doubly moot in this port: /needs/at/:slug/hit/ is registered POST-only,
    // and crawlers issue GETs. Asserting the current, wrong-but-faithful
    // string so that the day someone corrects it, it is a deliberate change
    // to crawler-visible behaviour rather than a silent one.
    const body = await (await get("/robots.txt")).text();

    expect(body).toContain("Disallow: /at/*/hit/");
    expect(body).not.toContain("Disallow: /needs/at/");
    expect(app.routes.every((route) => !route.path.startsWith("/at/"))).toBe(true);
    expect(registered("POST", "/needs/at/:slug/hit/")).toBe(true);
  });
});

describe("the SITE_DOMAIN binding", () => {
  it("uses whatever the binding says, on every Sitemap line and nowhere else", async () => {
    // wrangler.jsonc:177 sets SITE_DOMAIN to this suite's ORIGIN, so a
    // hardcoded literal in the handler would pass every other test in this
    // file. Serving one request with a different value is the only thing
    // that separates the two -- and it matters in the other direction too:
    // a preview deployment that advertised production's sitemaps would have
    // crawlers indexing the wrong host's URLs from the preview's robots.txt.
    //
    // The second half of the assertion is the one worth having: Disallow
    // takes a PATH, and a Disallow carrying a scheme and host is ignored by
    // every conforming parser, so a domain leaking onto those lines would
    // silently unprotect all ten of them.
    const body = await (await get("/robots.txt", undefined, env({ SITE_DOMAIN: "https://beta.example.invalid" }))).text();

    expect(startingWith(body, "Sitemap: ")).toEqual([
      "Sitemap: https://beta.example.invalid/sitemap.xml",
      "Sitemap: https://beta.example.invalid/cy/sitemap.xml",
      "Sitemap: https://beta.example.invalid/ga/sitemap.xml",
      "Sitemap: https://beta.example.invalid/gd/sitemap.xml",
      "Sitemap: https://beta.example.invalid/md/sitemap.xml",
    ]);
    for (const line of startingWith(body, "Disallow: ")) expect(line).not.toContain("://");
  });

  it("SUSPECT: writes the literal text \"undefined\" when the binding is missing", async () => {
    // Pinned rather than fixed (see this file's header). `${undefined}`
    // stringifies, so the five Sitemap lines become
    // "Sitemap: undefined/sitemap.xml" -- a 200 response, a well-formed
    // file, ten correct Disallow rules, and five sitemap URLs no crawler
    // can resolve. Sibling failure to manifest.ts's, which instead DELETES
    // start_url; both are the same root cause (an unvalidated binding
    // interpolated straight into output) with different symptoms, and
    // neither throws.
    //
    // wrangler.jsonc always sets the var, so this is a latent trap rather
    // than a live bug -- but it is exactly the class of silent failure a
    // file read only by robots cannot report.
    const body = await (await get("/robots.txt", undefined, env({ SITE_DOMAIN: undefined }))).text();

    expect(body).toContain("Sitemap: undefined/sitemap.xml");
    expect(startingWith(body, "Sitemap: ")).toHaveLength(5);
    // The rest of the file is untouched, which is what makes it invisible.
    expect(startingWith(body, "Disallow: ")).toHaveLength(10);
  });

  it("SUSPECT: a trailing slash on the binding produces a doubled slash", async () => {
    // Also pinned. The handler concatenates `${SITE_DOMAIN}${path}` with no
    // normalisation, and every path from url()/urlForLocale() already
    // begins with "/". "https://x/" + "/sitemap.xml" is
    // "https://x//sitemap.xml", which most servers serve and most crawlers
    // treat as a distinct URL. Same shape as the missing-binding case: no
    // throw, no log, a valid-looking file.
    const body = await (await get("/robots.txt", undefined, env({ SITE_DOMAIN: "https://www.givefood.org.uk/" }))).text();
    expect(body).toContain("Sitemap: https://www.givefood.org.uk//sitemap.xml");
  });
});

describe("the four locale registrations", () => {
  it("serves byte-identical content at all four paths", async () => {
    // robots.ts's central claim: Django's view never branches on
    // request.LANGUAGE_CODE, so all four registrations render the same
    // bytes, and this port keeps that. The file already lists every
    // locale's Disallow and Sitemap entries, so a per-locale variant would
    // not add information -- it would fragment the edge cache four ways for
    // identical content and, worse, invite a "helpful" future edit that
    // emits only the current locale's sitemap.
    const bodies = await Promise.all(
      ["/robots.txt", "/cy/robots.txt", "/ga/robots.txt", "/gd/robots.txt"].map(async (path) => {
        const res = await get(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("Content-Type"), path).toBe("text/plain");
        return res.text();
      }),
    );

    for (const body of bodies) expect(body).toBe(EXPECTED_BODY);
  });

  it("still stamps a per-locale Content-Language on that identical body", async () => {
    // resolveLanguage sets the header from the path prefix regardless of
    // what the handler produced, so /cy/robots.txt is an English-content
    // document labelled Welsh. Harmless for a robots.txt (there is no prose
    // in it) and pinned because the pairing looks like a bug when first
    // seen: it is the middleware's contract showing through, not this
    // handler doing something per-locale.
    for (const [path, lang] of [
      ["/robots.txt", "en"],
      ["/cy/robots.txt", "cy"],
      ["/ga/robots.txt", "ga"],
      ["/gd/robots.txt", "gd"],
    ] as const) {
      const res = await get(path);
      expect(res.headers.get("Content-Language"), path).toBe(lang);
    }
  });

  it("404s /en/robots.txt, because en is never a prefix", async () => {
    // middleware/resolveLanguage.ts: "en" is deliberately NOT in PREFIXES
    // (Django's prefix_default_language=False), and /en/ 404s in production
    // today. If a fifth registration were ever added in a loop that forgot
    // index.ts's `if (locale === "en") continue`, this is what catches it.
    const res = await get("/en/robots.txt");

    expect(res.status).toBe(404);
    // The 404 PAGE, not a robots.txt body -- i.e. it fell through to
    // app.notFound() rather than reaching this handler.
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
  });

  it("404s one of Django's other 17 languages", async () => {
    // PLAN.md §2.7.1: 4 languages, not 21. /pl/ has no matching prefix, so
    // resolveLanguage falls to "en" and no route matches -- the same
    // treatment production's own unconfigured /de/ already got. The
    // sitemaps this file advertises are the four that exist; a crawler that
    // guessed /pl/robots.txt gets nothing.
    const res = await get("/pl/robots.txt");

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en");
  });
});

describe("how the response is served", () => {
  it("returns byte-identical documents to two different requests", async () => {
    // No timestamp, no request id, no per-visitor field -- unlike Django's
    // version, whose debugcomment banner carried a wall-clock time and a
    // render duration. This purity is what makes a week-long, shared TTL
    // safe, and it is cheap to lose.
    const first = await (await get("/robots.txt")).text();
    const second = await (await get("/robots.txt")).text();
    expect(second).toBe(first);
  });

  it("mints no cookie and no Vary, so the edge may share one copy", async () => {
    // The response asks to be cached publicly for a week. A Set-Cookie
    // (which Cloudflare refuses to cache) or a Vary added by a future
    // middleware would quietly make it per-visitor or per-header --
    // resolveLanguage.ts records removing `Vary: Accept-Language` for
    // exactly that cost, having found two 2 MB copies of one JSON document
    // at one colo.
    const res = await get("/robots.txt");

    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
    // cacheTag.ts's AGGREGATE_PATHS matches /sitemap*.xml but not
    // /robots.txt, so this response carries no tag and cannot be purged by
    // queues/cachePurge.ts. Correct -- its content depends on no row in the
    // database -- and pinned so that widening the tag rule (whose regex
    // does contain "sitemap") is a deliberate act rather than a side effect.
    expect(res.headers.get("Cache-Tag")).toBeNull();
  });

  it("carries the three security headers every response gets", async () => {
    // securityHeaders sets these on c.res AFTER the handler returns, and
    // this handler returns a bare `new Response(...)` rather than going
    // through a Hono helper. That is the case where a middleware writing to
    // an immutable Response would fail -- worth one assertion on a route
    // that takes that path.
    const res = await get("/robots.txt");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("answers HEAD with the same headers and no body", async () => {
    // Not decoration: lib/appendSlash.ts probes with HEAD to decide whether
    // to 301, so HEAD behaviour on a real route is load-bearing routing
    // machinery here (that file's own tests use /robots.txt as the example
    // of a path that must never gain a trailing slash).
    const res = await get("/robots.txt", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(await res.text()).toBe("");
  });

  it("does not redirect /robots.txt/ to a slashless URL or vice versa", async () => {
    // lib/appendSlash.ts must not "helpfully" send a crawler from
    // /robots.txt to /robots.txt/. RFC 9309 says a crawler fetches exactly
    // /robots.txt and treats a redirect chain with suspicion; more to the
    // point, only the slashless path is registered, so a redirect would
    // land on a 404.
    expect((await get("/robots.txt")).status).toBe(200);
    expect((await get("/robots.txt/")).status).toBe(404);
  });

  it("404s a POST, where Django's path() would have answered it", async () => {
    // A DIVERGENCE, pinned. Django's urls.py:51 puts no method restriction
    // on robotstxt(), so a POST rendered the same text with a 200; index.ts
    // registers app.get only, so Hono has no matching route and it reaches
    // app.notFound(). Nothing posts to a robots.txt, so this is noted
    // rather than mourned.
    const res = await get("/robots.txt", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("ignores Accept-Language and a language cookie entirely", async () => {
    // PLAN.md §3.5's rule 1, restated at the top of
    // middleware/resolveLanguage.ts: the URL path prefix wins and is the
    // ONLY thing that ever wins. This document is public and cached for a
    // week; negotiating on a request header would put one visitor's
    // variant in front of everyone.
    const res = await get("/robots.txt", {
      headers: { "Accept-Language": "cy-GB,cy;q=0.9", Cookie: "django_language=cy" },
    });

    expect(await res.text()).toBe(EXPECTED_BODY);
    expect(res.headers.get("Content-Language")).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// robotsTxt OUTSIDE the router.
//
// index.ts only ever mounts this handler on the four paths above, and the
// four locale registrations are the ONLY reason `lang` is ever set for it.
// Unlike manifestJson, which reads c.get("lang") and throws on a locale
// outside LOCALES, this handler reads nothing from the request at all --
// not the path, not the language, not a header. That is a property worth
// writing down rather than inferring, because it is what makes the four
// registrations interchangeable.
//
// This is NOT a second copy of the router and asserts nothing about
// routing (every routing assertion above uses the real app). It mounts the
// REAL exported handler on a deliberately looser path to reach states the
// real paths cannot produce. Same device, and same reasoning, as
// routes/public/manifest.test.ts's guardHarness.
// ---------------------------------------------------------------------------
const looseHarness = new Hono<AppEnv>();
looseHarness.all("/:anything{.*}", async (c) => robotsTxt(c));

describe("robotsTxt reached with a language the router could never give it", () => {
  it("renders the same bytes with no lang set at all", async () => {
    // The harness never calls c.set("lang"), so c.get("lang") is undefined
    // here. manifestJson would throw in this state (its catalogue lookup
    // indexes a table by locale); this handler does not look, which is why
    // /cy/robots.txt and /robots.txt can be the same registration.
    const res = await looseHarness.fetch(new Request(`${ORIGIN}/robots.txt`), env(), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPECTED_BODY);
  });

  it("renders the same bytes for an unsupported locale and an unrelated path", async () => {
    // The control for the test above, and the actual claim: the output is a
    // function of SITE_DOMAIN and LOCALES only. Neither the request path nor
    // a `lang` outside the four locales changes a byte -- so if a fifth
    // registration or a mount at another path ever appears, it inherits the
    // same document rather than a subtly different one.
    const harness = new Hono<AppEnv>();
    harness.get("/:lang/robots.txt", async (c) => {
      c.set("lang", c.req.param("lang"));
      return robotsTxt(c);
    });

    const res = await harness.fetch(new Request(`${ORIGIN}/tlh/robots.txt`), env(), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPECTED_BODY);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("still answers a POST when nothing restricts the method", async () => {
    // The 404 on POST asserted earlier belongs to index.ts's `app.get`
    // registration, NOT to this handler -- it never looks at the method.
    // Recorded here so the earlier test cannot be mistaken for evidence
    // that the handler itself refuses writes: if this were ever mounted
    // with app.all (as /whatsapp_hook/ is), a POST would get the file.
    const res = await looseHarness.fetch(new Request(`${ORIGIN}/robots.txt`, { method: "POST" }), env(), execCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPECTED_BODY);
  });
});
