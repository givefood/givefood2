import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";
import { AGGREGATE_TAG, constituencyTag, foodbankTag } from "@givefood/urls";
import type { AppEnv } from "../types";
import { cacheTag } from "./cacheTag";
import { noStore } from "./noStore";
import { resolveLanguage } from "./resolveLanguage";

// WHAT BREAKS IF THESE FAIL. Cloudflare's purge_cache answers
// {"success": true} for a tag no response carries (see the header of
// packages/urls/src/cacheTags.test.ts), so a path rule that stops matching
// produces no exception, no 4xx and no log line -- just a food bank page
// that keeps serving yesterday's shopping list until its TTL runs out. The
// stamping side is the only place that can be caught, and this file is the
// place.
//
// EVERY TEST DRIVES A REAL HONO APP, not the internal tagsFor(). Only
// `cacheTag` is exported, deliberately: the path rule and the response
// gating are one contract, and the thing the rule reads -- c.req.path --
// only exists inside a request. Testing through app.request() also pins the
// ordering the middleware depends on (it runs on the unwind, after the
// handler and after any inner middleware's own header writes).

const HOST = "https://www.givefood.org.uk";

// sid-valley is the food bank cacheTag.ts:27 records a live probe against:
// a temporary X-Probe-Tag mirror came back `fb-sid-valley` on
// /needs/at/sid-valley/ and `fb-all` on /. Using the same slug keeps this
// file checkable against that note.
const FB = "sid-valley";

const ok: Handler<AppEnv> = (c) => c.text("body");

// `extra` is registered AFTER cacheTag on purpose. Hono unwinds
// post-response middleware in reverse registration order, so anything
// passed here runs BEFORE cacheTag's own post-next code -- the same
// relationship index.ts has between cacheTag (line 114) and noStore
// (lines 137-144) / pageCacheControl (line 125). Registering it the other
// way round would test an arrangement production does not have.
function serve(path: string, handler: Handler<AppEnv> = ok, extra?: MiddlewareHandler<AppEnv>, init?: RequestInit) {
  const app = new Hono<AppEnv>();
  app.use("*", cacheTag);
  if (extra) app.use("*", extra);
  app.all("*", handler);
  return app.request(HOST + path, init);
}

async function tag(path: string, handler?: Handler<AppEnv>, extra?: MiddlewareHandler<AppEnv>): Promise<string | null> {
  return (await serve(path, handler, extra)).headers.get("Cache-Tag");
}

// For paths the rule simply does not match. `expect(tag(p)).toBeNull()` on its
// own is a weak assertion: it also passes if the middleware THREW and Hono's
// error handler answered a tagless 500, so a `tagsFor` that blew up on every
// unmatched path would look exactly like correct non-matching. Since roughly
// half the assertions in this file are negative, that is the single most
// likely way a broken implementation could still show green. Pinning 200 and
// the untouched body alongside the absent header closes it.
async function untagged(path: string) {
  const res = await serve(path);
  expect(res.status, path).toBe(200);
  expect(res.headers.get("Cache-Tag"), path).toBeNull();
  expect(await res.text(), path).toBe("body");
}

describe("one food bank's own pages", () => {
  it("stamps fb-<slug> on the food bank page, the value the live probe returned", async () => {
    // cacheTag.ts:23-27: the header never reaches a browser because
    // Cloudflare strips it at the edge, so `curl -I` cannot check this and
    // the only record of the real value is that probe. This assertion is
    // the standing version of it.
    expect(await tag(`/needs/at/${FB}/`)).toBe("fb-sid-valley");
    expect(await tag(`/needs/at/${FB}/`)).toBe(foodbankTag(FB));
  });

  it("covers EVERY page beneath a food bank's path, including the ones Django's list forgets", async () => {
    // The reason this middleware exists at all (cacheTag.ts:10-17).
    // Django rebuilds a list of URLs by hand inside Foodbank.save()
    // (givefood/models/foodbank.py:717-758) and that list has never
    // mentioned /needs/at/<slug>/donationpoints/ or the donation point
    // pages under it -- so editing a food bank has never purged them.
    // A prefix rule over the path cannot have that gap: anything the
    // router mounts under /needs/at/<slug>/ is tagged the moment it
    // exists. The list below is every such route in index.ts, and it must
    // stay exhaustive-by-construction rather than exhaustive-by-memory.
    const beneath = [
      "", // the needs page itself
      "nearby/",
      "locations/",
      "donationpoints/", // <- absent from Django's purge list
      "donationpoint/tesco-sidmouth/", // <- and so is this
      "donationpoint/tesco-sidmouth/openinghours/",
      "news/",
      "charity/",
      "rss.xml",
      "geo.json",
      "photo.jpg",
      "map.png",
      "maps/300.png",
      "favicon.png",
      "screenshots/homepage.png",
      "sidmouth-church-hall/", // the :locslug catch-all
      "sidmouth-church-hall/geo.json",
      "donationpoint/tesco-sidmouth/favicon.png",
    ];
    for (const rest of beneath) {
      expect(await tag(`/needs/at/${FB}/${rest}`)).toBe(foodbankTag(FB));
    }
  });

  it("tags the three locale-prefixed copies of every one of those pages", async () => {
    // The prefixes are duplicated into this module as a plain regex
    // fragment (cacheTag.ts:34-39) so the rule has no ordering dependency
    // on resolveLanguage -- it reads c.req.path, which still carries the
    // prefix, and must work whether it runs before or after that
    // middleware. If the two lists drift, /cy/needs/at/<slug>/ stops being
    // purgeable while /needs/at/<slug>/ still is, which is invisible to
    // anyone testing in English.
    for (const locale of ["cy", "ga", "gd"]) {
      expect(await tag(`/${locale}/needs/at/${FB}/`)).toBe(foodbankTag(FB));
      expect(await tag(`/${locale}/needs/at/${FB}/locations/`)).toBe(foodbankTag(FB));
    }
  });

  it("tags the /md/ markdown mirror, which Django does purge (wfbn-md:md_foodbank)", async () => {
    expect(await tag(`/md/needs/at/${FB}/`)).toBe(foodbankTag(FB));
    expect(await tag(`/md/needs/at/${FB}/donationpoints/`)).toBe(foodbankTag(FB));
    expect(await tag(`/md/needs/at/${FB}/sidmouth-church-hall/`)).toBe(foodbankTag(FB));
  });

  it("ignores prefixes the router does not register: /en/ and the 17 dropped languages", async () => {
    // PLAN.md §2.7.1 -- this Worker serves en/cy/ga/gd only, and "en" is
    // never a URL prefix (resolveLanguage.ts:26, prefix_default_language=
    // False). Both of these 404 in production, so an untagged response is
    // the right answer twice over; pinned so that widening LOCALE to a
    // generic [a-z]{2} (which would also match "at", "in" and "md") is not
    // mistaken for a harmless tidy-up.
    await untagged(`/en/needs/at/${FB}/`);
    await untagged(`/de/needs/at/${FB}/`);
    await untagged(`/pl/needs/at/${FB}/`);
    // The three prefixes are a fixed alternation, not a shape. A rule
    // rewritten as `[a-z]{2,3}` -- which looks equivalent if you only ever
    // try /cy/, /ga/ and /gd/ -- would match all of these and start minting
    // tags for paths that 404, and would also swallow "/md" as a locale.
    await untagged(`/cym/needs/at/${FB}/`);
    await untagged(`/c/needs/at/${FB}/`);
    await untagged(`/cy/ga/needs/at/${FB}/`);
    // ...but a food bank may legitimately be SLUGGED like a locale, and the
    // optional group must not eat the slug: the prefix only matches in the
    // prefix position.
    expect(await tag("/needs/at/cy/")).toBe("fb-cy");
    expect(await tag("/cy/needs/at/cy/")).toBe("fb-cy");
  });

  it("is case-sensitive, like the Django urlconf it was ported from", async () => {
    // Django's URL patterns are case-sensitive and /NEEDS/AT/<slug>/ 404s in
    // production. Adding an `i` flag to these regexes to be "forgiving" would
    // mint tags for paths that cannot be served, and -- worse -- would make
    // the stamped tag disagree in case with the one workers/jobs purges,
    // since Cloudflare's tags are themselves case-sensitive.
    await untagged(`/NEEDS/AT/${FB}/`);
    await untagged("/MD/");
    await untagged("/SITEMAP.xml");
    await untagged(`/CY/needs/at/${FB}/`);
    // The slug's own case is preserved verbatim into the tag, though: it is
    // whatever the path said, never normalised.
    expect(await tag("/needs/at/Sid-Valley/")).toBe("fb-Sid-Valley");
  });

  it("needs a non-empty slug segment, and needs the literal /needs/at/ prefix", async () => {
    // The capture is ([^/]+), so there is no such thing as a tag of "fb-"
    // coming out of this middleware -- packages/urls' foodbankTag("")
    // documents that degenerate value as unreachable from the web, and
    // this is the half of that claim that lives here.
    await untagged("/needs/at/");
    await untagged("/needs/at");
    await untagged("/needs/atlas/");
    await untagged("/needs/");
    await untagged("/write/to/sid-valley/");
    // The md mirror and the locale copies capture through the same group, so
    // the empty-slug guard has to hold on those spellings too.
    await untagged("/md/needs/at/");
    await untagged("/cy/needs/at/");
  });

  it("puts a slug of any length through intact, with no truncation and no backtracking blowup", async () => {
    // `([^/]+)` has no upper bound and the tag is a plain interpolation, so a
    // 2,000-character segment comes out whole. Two things are being pinned:
    // that nothing silently truncates a tag (a truncated tag purges nothing,
    // the failure this whole file is about), and that a pathological segment
    // does not hang the request -- this middleware runs on "*" and therefore
    // on hostile traffic, and a regex that could backtrack here would be a
    // free CPU-limit exhaustion against every route on the site.
    const long = "a".repeat(2000);
    const started = Date.now();
    expect(await tag(`/needs/at/${long}/`)).toBe(`fb-${long}`);
    // Also the degenerate short end: one character is a legal segment.
    expect(await tag("/needs/at/a/")).toBe("fb-a");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("is purely lexical: only the status guard keeps fb-place off the wire", async () => {
    // /needs/at/place/<county>/<place>/ is the browse-by-place page, which
    // is permanently out of scope and answers 404 (index.ts:266). The path
    // rule cannot tell that apart from a food bank slugged "place" -- it
    // would happily emit fb-place -- and what actually stops the tag
    // shipping is the !c.res.ok return. Worth pinning both halves: someone
    // relaxing the status guard to "tag everything" would start minting
    // tags for every 404 under /needs/at/.
    expect(await tag("/needs/at/place/devon/exeter/")).toBe("fb-place");
    expect(await tag("/needs/at/place/devon/exeter/", (c) => c.notFound())).toBeNull();
  });
});

describe("one food bank's API representation", () => {
  it("tags /api/1/foodbank/<slug>/ and /api/2/foodbank/<slug>/", async () => {
    // Django purges both by hand: reverse("api_foodbank", slug) and the
    // api2:foodbank prefix (foodbank.py:740, :749).
    expect(await tag(`/api/1/foodbank/${FB}/`)).toBe(foodbankTag(FB));
    expect(await tag(`/api/2/foodbank/${FB}/`)).toBe(foodbankTag(FB));
    expect(await tag(`/api/1/foodbank/${FB}/`)).toBe("fb-sid-valley");
  });

  it("recognises exactly API versions 1, 2 and 3 -- not a generic digit", async () => {
    // `[123]` is an enumeration of the three mounts index.ts actually
    // registers (/api/1, /api/2, /api/3), not shorthand for "a number".
    // Loosening it to \d or [0-9]+ passes every other test in this file
    // while quietly tagging /api/9/... -- paths that 404 -- and, more to the
    // point, hides the fact that adding an /api/4 means editing this rule.
    // /api/3 is in the class today even though only its index page exists.
    expect(await tag(`/api/3/foodbank/${FB}/`)).toBe(foodbankTag(FB));
    await untagged(`/api/4/foodbank/${FB}/`);
    await untagged(`/api/0/foodbank/${FB}/`);
    await untagged(`/api/12/foodbank/${FB}/`);
    await untagged(`/api/v2/foodbank/${FB}/`);
  });

  it("needs a non-empty slug on the API form too", async () => {
    // Same `([^/]+)` guarantee as the HTML paths: /api/2/foodbank/ is the
    // (non-existent) list form of the singular route and must never produce
    // the degenerate tag "fb-".
    await untagged("/api/2/foodbank/");
    await untagged("/api/2/foodbank");
    await untagged("/api/2/constituency/");
  });

  it("never reads a LIST endpoint as a food bank named 'search'", async () => {
    // The trap the singular/plural split exists for. /api/2/foodbanks/ and
    // /api/2/foodbanks/search/ are aggregates; if FOODBANK_API's literal
    // lost its trailing slash it would capture "search" here and mint a
    // tag nothing ever purges, while the aggregate purge silently stopped
    // covering the list.
    expect(await tag("/api/2/foodbanks/")).toBe(AGGREGATE_TAG);
    expect(await tag("/api/2/foodbanks/search/")).toBe(AGGREGATE_TAG);
    expect(await tag("/api/1/foodbanks/search/")).toBe(AGGREGATE_TAG);
  });

  it("leaves the bare /api/ dual-mount aliases untagged -- SUSPECTED BUG, pinned as-is", async () => {
    // index.ts:156-163 quotes PLAN.md §10.2.2: gfapi2 is live at BOTH
    // /api/2/* and /api/*, and "only the /api/2/ forms are in the current
    // purge list, so the /api/ aliases have been going stale to TTL". The
    // regexes here require /api/[123]/, so the port reproduces that gap
    // rather than closing it -- /api/foodbank/<slug>/ serves identical
    // bytes to /api/2/foodbank/<slug>/ and carries no tag at all.
    // Current behaviour, documented not endorsed.
    await untagged(`/api/foodbank/${FB}/`);
    await untagged("/api/foodbanks/");
    await untagged("/api/constituency/hastings-and-rye/");
    await untagged("/api/locations/");
    await untagged("/api/donationpoints/");
  });

  it("leaves a single need's API representation untagged", async () => {
    // /api/2/need/<id>/ matches neither the singular foodbank rule nor the
    // plural "needs" aggregate. Django's do_decache does not list
    // api2:need either, so this is parity rather than regression -- but it
    // does mean a published need change only reaches the aggregates and
    // the food bank's own pages, never this endpoint.
    await untagged("/api/2/need/1234/");
    await untagged("/api/1/need/1234/");
  });
});

describe("constituencies", () => {
  it("tags the API representation pc-<slug>", async () => {
    // Django purges the api2:constituency prefix on every food bank save
    // (foodbank.py:750), because a constituency page lists the food banks
    // inside it.
    expect(await tag("/api/2/constituency/hastings-and-rye/")).toBe(constituencyTag("hastings-and-rye"));
    expect(await tag("/api/2/constituency/hastings-and-rye/")).toBe("pc-hastings-and-rye");
  });

  // github #18. This pair used to assert the miss, ending "Fixing the prefix
  // should flip these three to pc-hastings-and-rye." It did.
  //
  // CONSTITUENCY_PATH expected /constituency/<slug> at the ROOT of the path.
  // Nothing is served there; the real routes are /needs/in/constituency/... .
  // The consequence was the exact failure this design exists to prevent: a
  // silent purge miss. routes/admin/foodbank.ts queues
  // constituencyTag(parliamentary_constituency_slug) on every save, no HTML
  // response carried it, Cloudflare reports success:true for a tag nothing
  // matches, and the page kept listing the old need text, phone number and
  // email until its own week-long TTL. Django purges both URLs by name
  // (foodbank.py:751-752), so this was a regression against Django rather
  // than inherited behaviour.
  it("tags the constituency HTML page and its geo.json, in every locale", async () => {
    const expected = constituencyTag("hastings-and-rye");
    expect(await tag("/needs/in/constituency/hastings-and-rye/")).toBe(expected);
    expect(await tag("/needs/in/constituency/hastings-and-rye/geo.json")).toBe(expected);
    // All three locales, not just Welsh: index.ts registers the whole family
    // per locale, and the LOCALE fragment has to cover them.
    expect(await tag("/cy/needs/in/constituency/hastings-and-rye/")).toBe(expected);
    expect(await tag("/ga/needs/in/constituency/hastings-and-rye/")).toBe(expected);
    expect(await tag("/gd/needs/in/constituency/hastings-and-rye/geo.json")).toBe(expected);
  });

  it("still leaves the constituency LIST page untagged, which is parity and not this bug", async () => {
    // /needs/in/constituencies/ goes stale to TTL on a food bank save, and
    // Django never purged it either -- so this staleness is inherited, and
    // fixing #18 must not quietly change it. It is also the reason the
    // pattern says `constituency/` in full: `constituenc` would swallow the
    // plural and mint a tag for a page nothing purges.
    await untagged("/needs/in/constituencies/");
    await untagged("/cy/needs/in/constituencies/");
  });

  it("no longer tags a root-level /constituency/<slug>/, a path this site has never served", async () => {
    // The inverse of the fix, kept where its predecessor was. That test
    // existed to prove the capture group and the locale handling worked and
    // that only the prefix was wrong; now it guards the other direction --
    // a pattern loose enough to match both shapes would pass every other
    // assertion here while minting tags for URLs that do not exist.
    await untagged("/constituency/hastings-and-rye/");
    await untagged("/cy/constituency/hastings-and-rye/");
  });
});

describe("the aggregates -- fb-all", () => {
  it("covers the set Django re-lists on every single save", async () => {
    // foodbank.py:726-757, item by item: reverse("index") -> /,
    // wfbn:rss -> /needs/rss.xml, wfbn:geojson -> /needs/geo.json,
    // api_foodbanks -> /api/1/foodbanks/, api2:foodbanks, api2:locations,
    // api2:donationpoints, sitemap -> /sitemap.xml, md_index -> /md/.
    // If any of these stops matching, a food bank edit still purges its
    // own pages and quietly stops updating the home page.
    for (const path of [
      "/",
      "/needs/rss.xml",
      "/needs/geo.json",
      "/sitemap.xml",
      "/md/",
      "/api/1/foodbanks/",
      "/api/2/foodbanks/",
      "/api/2/locations/",
      "/api/2/donationpoints/",
      "/api/2/needs/",
      "/api/2/constituencies/",
    ]) {
      expect(await tag(path)).toBe(AGGREGATE_TAG);
    }
  });

  it("covers the locale variants of the home page, feeds and sitemap", async () => {
    // Django translates its whole page_urls list through LANGUAGES before
    // enqueuing (foodbank.py:733-736), so the locale copies were purged
    // there too. Only /cy//ga//gd/ exist here (§2.7.1).
    for (const locale of ["cy", "ga", "gd"]) {
      expect(await tag(`/${locale}/`)).toBe(AGGREGATE_TAG);
      expect(await tag(`/${locale}/needs/rss.xml`)).toBe(AGGREGATE_TAG);
      expect(await tag(`/${locale}/needs/geo.json`)).toBe(AGGREGATE_TAG);
      expect(await tag(`/${locale}/sitemap.xml`)).toBe(AGGREGATE_TAG);
    }
  });

  it("matches the API list endpoints by prefix, so their sub-paths and formats come too", async () => {
    // The API alternative is deliberately unanchored at its right-hand
    // end. Django had to enumerate "?format=csv" and "?format=geojson"
    // variants separately (foodbank.py:747-749) and purge api2 by prefix;
    // here every path under a list endpoint inherits the tag, and query
    // strings never entered into it because the rule reads c.req.path.
    expect(await tag("/api/1/foodbanks/?format=csv")).toBe(AGGREGATE_TAG);
    expect(await tag("/api/2/donationpoints/?format=geojson")).toBe(AGGREGATE_TAG);
    expect(await tag("/api/3/donationpoints/company/tesco/")).toBe(AGGREGATE_TAG);
    // Unanchored means unanchored, and the cost of that is spelled out here
    // rather than left to be discovered: the trailing slash is not required,
    // and a longer word starting with a list endpoint's name is swept in
    // too. Harmless while no such route exists, and the reason the rule is
    // cheap; but if /api/2/needsomething/ is ever registered as something
    // that is NOT a food bank aggregate, this test is the one that fails.
    expect(await tag("/api/2/foodbanks")).toBe(AGGREGATE_TAG);
    expect(await tag("/api/2/needsomething/")).toBe(AGGREGATE_TAG);
    // The left-hand end is anchored, though -- a list endpoint's name buried
    // deeper in the path is not an aggregate.
    await untagged("/oldsite/api/2/foodbanks/");
  });

  it("matches only the exact home page, not every page in the locale", async () => {
    // `(?:/cy)?/$` is anchored at both ends. A rule that lost the $ would
    // put fb-all on the entire site, which is not a broken purge but a
    // catastrophic one: every food bank edit would drop the whole zone.
    await untagged("/privacy/");
    await untagged("/about-us/");
    await untagged("/cy/privacy/");
    await untagged("/dashboard/");
    await untagged("/needs/");
    // The `$` is load-bearing at BOTH ends of the optional locale. `/cy` with
    // no trailing slash is not the Welsh home page (production redirects it),
    // and a rule relaxed to `/?$` -- which reads like a tidy-up -- would tag
    // it. Neither is `/index.html`, which is what a `^(?:/cy)?/` prefix rule
    // would sweep in along with the entire site.
    await untagged("/cy");
    await untagged("/cy/index.html");
    await untagged("/index.html");
  });

  it("anchors the site-wide feeds at the end of the path, in every locale", async () => {
    // `(?:/cy)?/needs/(?:rss\.xml|geo\.json)$`. Unlike the API list rule
    // immediately above, these two ARE anchored right, and the difference is
    // deliberate: /api/2/foodbanks/ has real sub-paths and format variants
    // that should inherit the tag, whereas /needs/rss.xml is a single
    // document with nothing beneath it. Dropping the `$` here is the kind of
    // "make them consistent" edit that looks like tidying and quietly widens
    // fb-all onto paths the home page purge does not own -- it was the one
    // mutation this file did not catch before this test existed.
    expect(await tag("/needs/rss.xml")).toBe(AGGREGATE_TAG);
    expect(await tag("/needs/geo.json")).toBe(AGGREGATE_TAG);
    await untagged("/needs/rss.xml/");
    await untagged("/needs/geo.json/foo");
    await untagged("/needs/rss.xmlx");
    await untagged("/cy/needs/geo.json/x");
    // ...and the food bank's OWN feeds live under /needs/at/<slug>/, so they
    // carry that food bank's tag rather than fb-all. Two rules, one word
    // apart in the path.
    expect(await tag(`/needs/at/${FB}/rss.xml`)).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/geo.json`)).toBe(foodbankTag(FB));
  });

  it("anchors the sitemap alternatives at both ends", async () => {
    // Two separate alternatives do this work: `^/sitemap[^/]*\.xml$` for the
    // root-level family and `^(?:/cy)?/sitemap\.xml$` for the locale copies.
    // The seams between them are where a regression would land, and none of
    // these spellings is a page: a match would mean fb-all on something the
    // home page purge does not own.
    expect(await tag("/sitemap.xml")).toBe(AGGREGATE_TAG);
    expect(await tag("/sitemapindex.xml")).toBe(AGGREGATE_TAG);
    // `[^/]*` cannot cross a slash, so a sitemap in a subdirectory is out...
    await untagged("/sitemap/foodbanks.xml");
    // ...the `$` means the extension must end the path...
    await untagged("/sitemap.xml.gz");
    await untagged("/sitemap.xml/");
    await untagged("/sitemap.txt");
    // ...and the locale alternative is the EXACT name only, so the
    // out-of-scope places sitemaps are root-level-only matches. /cy/ plus a
    // non-canonical sitemap name matches neither alternative.
    await untagged("/cy/sitemap_places.xml");
    await untagged("/cy/sitemap.xml.gz");
  });

  it("does not tag the markdown mirror's own sitemaps -- current behaviour", async () => {
    // /md/ itself is an aggregate (Django's md_index) but /md/sitemap.xml
    // and /md/sitemap.md are not: the sitemap alternative is anchored at
    // the path root with ^/sitemap, and /md/?$ ends at the /md/ segment.
    // Both files list every food bank. Django does not purge them either
    // (only reverse("sitemap")), so this is inherited rather than new --
    // recorded here because it looks like an oversight from the outside
    // and someone should decide rather than rediscover.
    await untagged("/md/sitemap.xml");
    await untagged("/md/sitemap.md");
    // ...while /md and /md/ both match, trailing slash optional.
    expect(await tag("/md")).toBe(AGGREGATE_TAG);
    expect(await tag("/md/")).toBe(AGGREGATE_TAG);
    // `/md/?$` ends there: the `?` is on the slash, not on the whole
    // segment, so nothing else beginning "md" is the markdown index.
    await untagged("/mdx");
    await untagged("/md/index.md");
    await untagged("/cy/md/");
  });

  it("matches the out-of-scope sitemap names too, where the 404 is what stops the tag", async () => {
    // /sitemap[^/]*.xml catches sitemap_places.xml and friends, which are
    // permanently out of scope and answer 404 (index.ts's OUT_OF_SCOPE
    // list). Same shape as the fb-place case: the lexical rule matches and
    // the status guard is the thing that keeps the header off the wire.
    expect(await tag("/sitemap_places.xml")).toBe(AGGREGATE_TAG);
    expect(await tag("/sitemap_places.xml", (c) => c.notFound())).toBeNull();
  });
});

describe("which responses get stamped at all", () => {
  it("skips every non-2xx, because there is nothing worth purging on one", async () => {
    // cacheTag.ts:29-32. A 404 with a tag would be purgeable but pointless
    // noise; a redirect's Location is the router's business. Uses real
    // helpers so a change in how Hono builds these is caught too.
    expect(await tag(`/needs/at/${FB}/`, (c) => c.notFound())).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, (c) => c.redirect("/needs/", 302))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, (c) => c.redirect("/needs/at/other/", 301))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, (c) => c.text("boom", 500))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, (c) => c.text("nope", 403))).toBeNull();
  });

  it("uses Response.ok, so 204 and 299 are in and 300 is out", async () => {
    // The boundary spelled out. 304 in particular matters: routes/media.ts
    // answers a matched If-None-Match with a bare 304 and no body, and
    // that response correctly gets no tag -- there is nothing in it to
    // purge, and the cached 200 it refers to already carries one.
    expect(await tag(`/needs/at/${FB}/`, () => new Response(null, { status: 204 }))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/`, () => new Response(null, { status: 299 }))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/`, () => new Response(null, { status: 300 }))).toBeNull();
    expect(await tag(`/needs/at/${FB}/photo.jpg`, () => new Response(null, { status: 304 }))).toBeNull();
  });

  it("skips anything middleware/noStore.ts has marked, using the real middleware", async () => {
    // cacheTag.ts:29-31 names noStore by file. The check is a substring
    // test against whatever string that module writes, so the two are
    // coupled whether or not anyone notices: composing the real thing is
    // the only way this stays true if its header is ever reworded.
    //
    // noStore is registered INNER (see serve()), matching index.ts, so its
    // post-response header write has already happened when cacheTag looks.
    // Reversing that registration order is a real and quiet regression --
    // cacheTag would read an empty Cache-Control and stamp the response --
    // which is why this goes through the middleware rather than setting
    // the header in the handler.
    const res = await serve(`/needs/at/${FB}/updates/unsubscribe/`, ok, noStore);
    expect(res.headers.get("Cache-Tag")).toBeNull();
    // The suppression must be a decision, not a casualty: the response is
    // still a normal 200 carrying noStore's own header. Without this, a
    // cacheTag that threw whenever Cache-Control was set would pass.
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store, max-age=0, must-revalidate");
    // ...and the aggregate paths are equally exempt when marked.
    expect(await tag("/", ok, noStore)).toBeNull();
  });

  it("skips 'private' and 'no-store' independently", async () => {
    // Either directive alone is enough: a response barred only from shared
    // caches is not in Cloudflare's cache to purge, and one barred from
    // storage anywhere is not in any cache at all.
    const withCC = (value: string): Handler<AppEnv> => (c) => c.text("body", 200, { "Cache-Control": value });
    expect(await tag(`/needs/at/${FB}/`, withCC("private, max-age=0"))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, withCC("no-store"))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, withCC("private, no-store, max-age=0, must-revalidate"))).toBeNull();
  });

  it("finds the directive ANYWHERE in the header, not only at the front", async () => {
    // `includes()`, not `startsWith()`. Every no-store header this Worker
    // writes today happens to begin with "private", so a check narrowed to
    // the first directive -- which is what "tighten this up so it can't match
    // inside another token" turns into -- would pass every other test in this
    // file and still stamp a purgeable tag on a response that must not be
    // cached. Cache-Control has no required directive order, and
    // "max-age=0, private" is an entirely ordinary way to write it; R2's
    // writeHttpMetadata echoes back whatever was stored on the object, so
    // this Worker does not control the ordering on media responses at all.
    const withCC = (value: string): Handler<AppEnv> => (c) => c.text("body", 200, { "Cache-Control": value });
    expect(await tag(`/needs/at/${FB}/`, withCC("max-age=0, private"))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, withCC("public, max-age=0, no-store"))).toBeNull();
    expect(await tag(`/needs/at/${FB}/photo.jpg`, withCC("max-age=31536000, immutable, private"))).toBeNull();
    expect(await tag(`/needs/at/${FB}/`, withCC("must-revalidate, no-store"))).toBeNull();
  });

  it("bans ONLY 'no-store' and 'private', not every cautious-looking directive", async () => {
    // The guard is two substring tests, and the list is deliberately short:
    // a response that is merely revalidated on every use is still IN the
    // shared cache and still needs purging. `no-cache` is the trap -- it
    // reads like "do not cache" and shares seven characters with "no-store"
    // -- and a guard widened to include it (or to any `no-` prefix) would
    // stop tagging every must-revalidate route while looking more careful,
    // not less. Nothing else in this file would notice.
    const withCC = (value: string): Handler<AppEnv> => (c) => c.text("body", 200, { "Cache-Control": value });
    expect(await tag(`/needs/at/${FB}/`, withCC("no-cache"))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/`, withCC("public, max-age=0, must-revalidate"))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/`, withCC("public, s-maxage=60, stale-while-revalidate=30"))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/`, withCC("public, no-transform"))).toBe(foodbankTag(FB));
    // An empty Cache-Control is the `?? ""` fallback's other spelling and
    // contains neither banned substring, so it is treated as cacheable.
    expect(await tag(`/needs/at/${FB}/`, withCC(""))).toBe(foodbankTag(FB));
  });

  it("reads Cache-Control off the RESPONSE, never off the request", async () => {
    // A client can send `Cache-Control: no-store` on its own request. If the
    // guard ever read c.req.header() instead of c.res.headers, any visitor
    // -- or any crawler with an opinionated proxy -- could unilaterally strip
    // the tag off a cacheable page, and that page would then never be purged
    // for anyone. Nothing in the module says "response" out loud beyond the
    // c.res in the expression itself, which is exactly why it needs a test.
    const res = await serve(`/needs/at/${FB}/`, ok, undefined, {
      headers: { "Cache-Control": "no-store, private" },
    });
    expect(res.headers.get("Cache-Tag")).toBe(foodbankTag(FB));
  });

  it("stamps a normal cacheable response, including the exact header pageCacheControl writes", async () => {
    // "public, max-age=300, s-maxage=86400" is what
    // middleware/pageCacheControl.ts:131 puts on a food bank page. It
    // contains neither banned substring, and it must not start to: a
    // regression there would silently stop every HTML page being
    // purgeable.
    const withCC = (value: string): Handler<AppEnv> => (c) => c.text("body", 200, { "Cache-Control": value });
    expect(await tag(`/needs/at/${FB}/`, withCC("public, max-age=300, s-maxage=86400"))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/photo.jpg`, withCC("public, max-age=31536000, immutable"))).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/`, withCC("public, max-age=10"))).toBe(foodbankTag(FB));
  });

  it("stamps a response with no Cache-Control at all", async () => {
    // The `?? ""` fallback. Most HTML routes set nothing themselves and
    // rely on pageCacheControl; if that middleware is ever removed or
    // reordered, tagging must not quietly stop.
    const res = await serve(`/needs/at/${FB}/`, () => new Response("body", { status: 200 }));
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("Cache-Tag")).toBe(foodbankTag(FB));
  });

  it("matches Cache-Control case-sensitively -- current behaviour, not a rule of HTTP", async () => {
    // HTTP directives are case-insensitive, and `includes()` is not, so an
    // upper-cased "PRIVATE" would be stamped. Nothing in this Worker emits
    // one (noStore.ts:41 and pageCacheControl.ts:131 are both lowercase
    // literals, and R2's writeHttpMetadata echoes what was stored), so
    // this is a documented shape rather than a live path -- pinned so that
    // if it ever becomes live the note is already here.
    const upper: Handler<AppEnv> = (c) => c.text("body", 200, { "Cache-Control": "PRIVATE, NO-STORE" });
    expect(await tag(`/needs/at/${FB}/`, upper)).toBe(foodbankTag(FB));
  });

  it("has no method guard, unlike pageCacheControl", async () => {
    // pageCacheControl.ts:104 returns early for anything but GET. This
    // does not, so a 200 from POST /needs/at/<slug>/hit/ is stamped.
    // Harmless -- nothing caches a POST response, so the tag is noise
    // rather than a wrong purge -- but it is a real difference between two
    // sibling middlewares and worth being deliberate about.
    const res = await serve(`/needs/at/${FB}/hit/`, ok, undefined, { method: "POST" });
    expect(res.headers.get("Cache-Tag")).toBe(foodbankTag(FB));
    // HEAD is the one that would actually matter if it diverged: a cache
    // stores a HEAD response against the same key as its GET, so a HEAD that
    // arrived untagged could seed an unpurgeable entry.
    const head = await serve(`/needs/at/${FB}/`, ok, undefined, { method: "HEAD" });
    expect(head.headers.get("Cache-Tag")).toBe(foodbankTag(FB));
  });

  it("does not tag the 500 a thrown handler produces, on a path that otherwise would be", async () => {
    // Worth knowing exactly how this arrives, because it is not what the
    // shape of the middleware suggests: Hono's compose wraps EVERY handler
    // call in its own try/catch and invokes app.onError at the throw site
    // (hono/dist/compose.js:20-30), so the exception never propagates out
    // through cacheTag's `await next()`. By the time this middleware's tail
    // resumes, the error is already a finalized 500 sitting in c.res.
    //
    // Which means `if (!c.res.ok) return` is the ONLY thing keeping a tag off
    // the site's error page -- there is no exception unwinding past to do it.
    // That matters more than it sounds: a 500 rendered for one food bank and
    // then cached under fb-<slug> would be purgeable, so the failure would
    // look "handled" while every visitor got the error page until the next
    // save. The path here is a real food bank page, so tagsFor() genuinely
    // returns a tag and only the status check discards it.
    const app = new Hono<AppEnv>();
    let sawError: unknown = null;
    app.use("*", cacheTag);
    app.all("*", () => {
      throw new Error("handler exploded");
    });
    app.onError((err, c) => {
      sawError = err;
      return c.text("error", 500);
    });
    const res = await app.request(`${HOST}/needs/at/${FB}/`);
    expect((sawError as Error | null)?.message).toBe("handler exploded");
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Tag")).toBeNull();
    // ...and the same path with the same handler NOT throwing is tagged, so
    // the assertion above is about the 500 and not about the app wiring.
    const fine = new Hono<AppEnv>();
    fine.use("*", cacheTag);
    fine.all("*", ok);
    fine.onError((_e, c) => c.text("error", 500));
    expect((await fine.request(`${HOST}/needs/at/${FB}/`)).headers.get("Cache-Tag")).toBe(foodbankTag(FB));
  });
});

describe("writing the header", () => {
  it("appends to routes/media.ts's own tags rather than replacing them", async () => {
    // cacheTag.ts:92-95. A food bank's photo must stay purgeable three
    // ways: by "media" (drop every photo), by "media-<slug>" (drop this
    // food bank's photos) and by "fb-<slug>" (the food bank was edited).
    // media.ts:163 writes the first two as a hand-built literal in a
    // lowercase "cache-tag"; Headers lookups are case-insensitive, so the
    // read here finds it -- a detail that would break silently if this
    // ever moved to a raw object or a Map.
    const media: Handler<AppEnv> = () =>
      new Response("jpeg", { status: 200, headers: { "cache-tag": `media, media-${FB}` } });
    const header = await tag(`/needs/at/${FB}/photo.jpg`, media);
    expect(header).toBe("media, media-sid-valley, fb-sid-valley");
    // Cloudflare splits Cache-Tag on commas, so the round trip must give
    // back exactly three separately-purgeable tags.
    expect(header?.split(", ")).toEqual(["media", "media-sid-valley", "fb-sid-valley"]);
  });

  it("leaves an existing header untouched when the path yields no tags of its own", async () => {
    // The `if (!tags.length) return` sits BEFORE the read-and-append, so a
    // media response on a path this rule knows nothing about keeps its own
    // header verbatim -- no trailing comma, no empty tag. /static/img/ar/*
    // is served by staticMedia.ts and is not under any food bank.
    const media: Handler<AppEnv> = () =>
      new Response("png", { status: 200, headers: { "cache-tag": "media, media-ar" } });
    expect(await tag("/static/img/ar/marker.png", media)).toBe("media, media-ar");
  });

  it("treats an EMPTY existing header as no header, rather than prepending an empty tag", async () => {
    // The append is guarded by `existing ? ... : ...`, a truthiness test, not
    // a null test. It matters because Headers.get() returns "" -- not null --
    // for a header that was set to the empty string, and the two plausible
    // spellings diverge exactly here: `existing !== null` would emit
    // ", fb-sid-valley" with a leading empty element. Cloudflare splits
    // Cache-Tag on commas, so that leading empty tag is a malformed member of
    // the list, and depending on how strictly the API validates it the whole
    // header can be rejected -- taking the real tag down with it.
    const blank: Handler<AppEnv> = () =>
      new Response("jpeg", { status: 200, headers: { "cache-tag": "" } });
    const header = await tag(`/needs/at/${FB}/photo.jpg`, blank);
    expect(header).toBe("fb-sid-valley");
    expect(header?.startsWith(",")).toBe(false);
  });

  it("appends blindly, without de-duplicating a tag the handler already set", async () => {
    // Current behaviour, worth knowing before someone relies on either
    // reading: if media.ts (or anything else) ever writes fb-<slug> itself,
    // the header carries it twice. Harmless to Cloudflare -- purging by a tag
    // listed twice purges once -- but it means this middleware is not the
    // place a duplicate would be caught, and a future "tidy" dedupe would be
    // a behaviour change rather than a no-op.
    const dup: Handler<AppEnv> = () =>
      new Response("jpeg", { status: 200, headers: { "cache-tag": `media, ${foodbankTag(FB)}` } });
    expect(await tag(`/needs/at/${FB}/photo.jpg`, dup)).toBe("media, fb-sid-valley, fb-sid-valley");
  });

  it("stamps a Response the handler built itself, not just Hono's helpers", async () => {
    // cacheTag.ts:19-21 -- it writes to c.res on the way out precisely so
    // that a handler returning `new Response(...)` (media.ts, the geojson
    // routes, anything streaming) is covered without having to remember
    // anything.
    const raw: Handler<AppEnv> = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const res = await serve(`/api/2/foodbank/${FB}/`, raw);
    expect(res.headers.get("Cache-Tag")).toBe(foodbankTag(FB));
    expect(await res.text()).toBe("{}"); // and the body is untouched
    // Writing one header must not rebuild the response and lose the rest of
    // it. A `new Response(body, { headers: { "Cache-Tag": ... } })` style fix
    // for the immutable-headers case below would pass the assertion above and
    // silently drop the content type -- which is why status and the handler's
    // own headers are pinned here rather than taken on trust.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("throws on a response with IMMUTABLE headers, answering 500 -- SUSPECTED BUG", async () => {
    // A Response that came straight out of fetch() has a Headers guard of
    // "immutable", so `c.res.headers.set(...)` raises TypeError rather
    // than writing. Hono's own c.header() rebuilds the Response first
    // (context.js:213-216) and is immune; this middleware reaches past it
    // and is not. noStore.ts and pageCacheControl.ts both use c.header().
    //
    // Reachable in production: routes/media.ts:204's transform-failure
    // fallback does `return fetch(src.toString())` -- returning the raw
    // subrequest response -- on a path (/needs/at/<slug>/photo.jpg?s=200)
    // that matches FOODBANK_PATH, so tags are non-empty and the set fires.
    // A degraded-but-correct image would become a 500.
    //
    // Confirmed under Node/undici here; whether workerd applies the same
    // immutable guard has not been verified against a live request, so
    // this is "suspected", not proven, in production. Pinned as current
    // behaviour rather than fixed -- a fix (c.header, or rebuilding the
    // Response) should flip this to 200 with fb-sid-valley.
    //
    // No network: a data: URL is served by fetch() itself, and it is the
    // only way to obtain an immutable-headers Response in-process.
    //
    // The premise is asserted before the conclusion, because otherwise this
    // test proves nothing: if fetch() simply REJECTED for a data: URL the app
    // would answer 500 as well, and the assertions below would pass for a
    // reason that has nothing to do with header guards. So pin that the fetch
    // succeeds, and that it is specifically the header write that throws.
    const fetchedDirectly = await fetch("data:image/jpeg;base64,AAAA");
    expect(fetchedDirectly.status).toBe(200);
    expect(() => fetchedDirectly.headers.set("Cache-Tag", "fb-x")).toThrow(TypeError);

    const fetched: Handler<AppEnv> = async () => await fetch("data:image/jpeg;base64,AAAA");
    const res = await serve(`/needs/at/${FB}/photo.jpg`, fetched);
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Tag")).toBeNull();

    // ...and the blast radius is limited to paths the rule matches. The same
    // immutable response on an untagged path sails through, because the
    // `if (!tags.length) return` happens before the write. That asymmetry is
    // the reason this bug would present as "some images 500 and some do
    // not" rather than as an outage.
    const elsewhere = await serve("/static/img/ar/marker.png", fetched);
    expect(elsewhere.status).toBe(200);
  });
});

describe("what the rule reads", () => {
  it("reads the path only, so query strings never change or defeat a tag", async () => {
    // c.req.path excludes the query. This is what makes /needs/?lat_lng=...
    // and ?format=csv fall under the same tag as their bare paths, and it
    // is why the API list rule did not need Django's separate ?format=
    // entries (foodbank.py:747-748).
    expect(await tag(`/needs/at/${FB}/?utm_source=newsletter`)).toBe(foodbankTag(FB));
    expect(await tag(`/needs/at/${FB}/photo.jpg?s=300&f=webp`)).toBe(foodbankTag(FB));
    // The two that actually prove it. Every `$`-anchored alternative would
    // stop matching if the query string were part of what the regex sees, and
    // the home page is the one whose loss would be least visible -- it would
    // simply stop being purged for requests that carry any parameter at all,
    // which is most of the traffic that arrives from search and email.
    expect(await tag("/?lat_lng=50.7,-3.2")).toBe(AGGREGATE_TAG);
    expect(await tag("/needs/rss.xml?utm_medium=feed")).toBe(AGGREGATE_TAG);
    expect(await tag("/cy/?q=")).toBe(AGGREGATE_TAG);
    expect(await tag("/sitemap.xml?page=2")).toBe(AGGREGATE_TAG);
    // A bare "?" with no query is the same path.
    expect(await tag("/?")).toBe(AGGREGATE_TAG);
    // And a query cannot smuggle a match in either: the rule sees /privacy/,
    // not the food-bank-looking text after the "?".
    await untagged(`/privacy/?next=/needs/at/${FB}/`);
  });

  it("does not care whether it runs before or after resolveLanguage", async () => {
    // cacheTag.ts:34-38 states this as the reason LOCALE is duplicated here
    // instead of imported: the rule reads c.req.path, which still carries the
    // prefix, so neither middleware has to know about the other. In
    // production cacheTag is registered FIRST (index.ts:114 vs :119), which
    // means its post-response code runs LAST -- after resolveLanguage has
    // already set `pathAfterPrefix` to the STRIPPED path. That is the trap:
    // an implementation that reached for c.get("pathAfterPrefix") would look
    // correct on every locale path in this file and would only break the day
    // the two disagreed. Composing the real middleware in both orders is the
    // check the claim asks for.
    for (const cacheTagFirst of [true, false]) {
      const app = new Hono<AppEnv>();
      if (cacheTagFirst) {
        app.use("*", cacheTag);
        app.use("*", resolveLanguage);
      } else {
        app.use("*", resolveLanguage);
        app.use("*", cacheTag);
      }
      app.all("*", ok);
      const res = await app.request(`${HOST}/cy/needs/at/${FB}/locations/`);
      expect(res.headers.get("Cache-Tag"), `cacheTagFirst=${cacheTagFirst}`).toBe(foodbankTag(FB));
      // resolveLanguage really did run and really did strip the prefix, so
      // the two are genuinely reading different things.
      expect(res.headers.get("Content-Language")).toBe("cy");
      const home = await app.request(`${HOST}/cy/`);
      expect(home.headers.get("Cache-Tag"), `cacheTagFirst=${cacheTagFirst}`).toBe(AGGREGATE_TAG);
    }
  });

  it("sees a percent-DECODED path, so an encoded slug can put a space inside a tag", async () => {
    // Hono decodes c.req.path with decodeURI the moment it sees a "%"
    // (hono/dist/utils/url.js, getPath -> tryDecodeURI), which is not
    // obvious from this module and is the one input shape where the tag
    // stamped here could differ from the tag workers/jobs purges. %20
    // becomes a real space; %2F does not become a slash, because decodeURI
    // leaves reserved characters alone -- so the slug stays one segment.
    //
    // Not reachable from the web: neither of these resolves to a food bank
    // in D1, so the response is a 404 and the status guard drops the tag
    // before it ships. Pinned because packages/urls' own tests note that
    // nothing escapes a slug on the way into the header, and this is where
    // an unescaped one would have to come from.
    expect(await tag("/needs/at/sid%20valley/")).toBe("fb-sid valley");
    expect(await tag("/needs/at/a%2Fb/")).toBe("fb-a%2Fb");
    expect(await tag("/needs/at/sid%20valley/", (c) => c.notFound())).toBeNull();
    // The %2F case is the one that matters most, and the assertion above is
    // only half of it: what must NOT happen is the decoded slash splitting
    // the segment, because then a slug could reach past its own path and the
    // tag would be truncated at the fake boundary.
    expect(await tag("/needs/at/a%2Fb/")).not.toBe("fb-a");
    // Decoding happens ONLY when a "%" is present (Hono checks for one
    // before calling decodeURI), so an ordinary path is never round-tripped.
    expect(await tag("/needs/at/sid-valley%2Feast/")).toBe("fb-sid-valley%2Feast");
  });

  it("carries a Latin-1 accented slug through to the tag, encoded or not", async () => {
    // Every UK food bank slug is ASCII today, so this is about the day one is
    // not -- Welsh and Gaelic place names in particular. The two spellings of
    // one request must produce the SAME tag, because a browser sends the
    // encoded form while workers/jobs purges whatever slug D1 holds: if the
    // encoded request stamped fb-caf%C3%A9 and the purge asked for fb-café,
    // Cloudflare would answer {"success": true} and change nothing. Hono's
    // decodeURI is what makes the two agree.
    expect(await tag("/needs/at/caf%C3%A9/")).toBe("fb-café");
    expect(await tag("/needs/at/café/")).toBe("fb-café");
    // é is U+00E9, which fits in a header. The next test is where that runs
    // out.
  });

  it("throws on a slug outside Latin-1, answering 500 -- SUSPECTED BUG, pinned as-is", async () => {
    // A header value is a ByteString: every code point must be <= 255. The
    // tag is interpolated straight from the decoded path, so a slug
    // containing ŷ (U+0177) or any CJK character makes headers.set() raise
    // TypeError, cacheTag has no try/catch, and the response becomes a 500.
    // Same shape as the immutable-headers bug above -- this middleware is the
    // only thing on the request that can turn a routed page into a 500 -- and
    // the same fix (guarding the write) covers both.
    //
    // NOT reachable from the web today, and the reason is the status guard,
    // not the tag: no such slug exists in D1, so the route 404s and
    // `if (!c.res.ok) return` fires before the write. It becomes reachable
    // the moment a food bank is slugged with a non-Latin-1 character -- one
    // Welsh "ŷ" or "ô" -- at which point that food bank's every page 500s.
    // Pinned as current behaviour per the no-failing-tests rule; the fix
    // should flip these to 200 with the tag percent-encoded (which would then
    // also need queues/cachePurge.ts to encode it the same way).
    for (const path of ["/needs/at/llanfair-p%C5%B7/", "/needs/at/食料銀行/", "/api/2/foodbank/%E5%A4%A7/"]) {
      const res = await serve(path);
      expect(res.status, path).toBe(500);
      expect(res.headers.get("Cache-Tag"), path).toBeNull();
    }
    // The 404 guard is what stands between that and production, so pin it:
    // an unroutable non-Latin-1 slug answers 404, not 500.
    const notFound = await serve("/needs/at/食料銀行/", (c) => c.notFound());
    expect(notFound.status).toBe(404);
  });

  it("does not throw on a malformed percent-escape, and does not invent a decoded slug for one", async () => {
    // decodeURI("%zz") throws URIError. Hono catches it and hands back the
    // raw path (utils/url.js, tryDecodeURI), so the rule still runs and the
    // tag keeps the escape verbatim. Worth pinning because the failure mode
    // if that ever changed is not a wrong tag but a 500 on a URL any scanner
    // can generate, on middleware registered at "*" -- i.e. site-wide.
    expect(await tag("/needs/at/%zz/")).toBe("fb-%zz");
    expect(await tag("/needs/at/50%/")).toBe("fb-50%");
    // The aggregate rules are `$`-anchored, so a broken escape at the end of
    // the home page's path must not accidentally still look like "/".
    await untagged("/%zz/");
  });

  it("never throws on an odd path, and never invents a tag for one", async () => {
    // The middleware runs on "*" (index.ts:114), so it sees every request
    // that reaches the Worker, including scanner traffic. An exception
    // here would turn a 404 into a 500 across the whole site.
    for (const path of ["/", "//", "/needs/at//", "/../../etc/passwd", "/needs/at/.", "/%2e%2e/", "/wp-login.php"]) {
      await expect(serve(path)).resolves.toBeInstanceOf(Response);
    }
    await untagged("/needs/at//");
    await untagged("/wp-login.php");
    await untagged("//");
    // "/" is the one path in that list that DOES match, and it must still be
    // the home page rather than collateral from the odd ones around it --
    // otherwise a rule broken into never matching would pass this test by
    // tagging nothing at all.
    expect(await tag("/")).toBe(AGGREGATE_TAG);
  });

  it("sees a path the URL parser has already resolved, so dot segments cannot forge a tag", async () => {
    // Worth knowing where the normalisation happens, because it is NOT in
    // this module and nothing in it hints that anything cleaned the path:
    // `new URL()` resolves "." and ".." per the WHATWG rules before Hono ever
    // reads a path, so the regexes never see a traversal segment and there is
    // no such thing as a tag of "fb-..".
    //
    // The consequence runs both ways, which is why it is pinned. A traversal
    // cannot mint a junk tag...
    await untagged("/needs/at/../");
    await untagged("/needs/at/.");
    // ...but it CAN reach a real one by a spelling nobody would grep for, and
    // that is correct: the two URLs are the same resource, so they had better
    // carry the same tag.
    expect(await tag("/needs/at/other/../sid-valley/")).toBe(foodbankTag(FB));
    expect(await tag("/privacy/../")).toBe(AGGREGATE_TAG);
    // ...and encoding the dots does not evade it either: the URL parser
    // treats %2e as "." for the purposes of that normalisation, so the classic
    // scanner spelling collapses the same way rather than arriving here as a
    // literal slug containing dots.
    await untagged("/needs/at/%2e%2e/");
    await untagged("/needs/at/%2E%2E/");
  });
});
