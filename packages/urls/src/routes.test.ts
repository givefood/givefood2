import { describe, expect, it } from "vitest";
import { I18N_SCOPED, PARAMETERISED, ROUTES } from "./routes";

// These three tables are the port's stand-in for Django's reverse() table,
// and routes.ts says so in its header: "do not let it silently drift from
// givefood/urls.py in the meantime". Drift is exactly what these tests are
// for. Every literal path asserted below was read off the Django source in
// the sibling checkout, and the comment on each block names the file and the
// pattern it came from, so a future reader can re-derive it rather than
// trusting the number:
//
//   givefood/urls.py            -- root patterns, the i18n_patterns block
//   gfwfbn/urls/i18n.py         -- "wfbn:*",         included at "needs/"
//   gfwfbn/urls/generic.py      -- "wfbn-generic:*", included at "needs/"
//   gfwfbn/urls/md.py           -- "wfbn-md:*",      included at "md/needs/"
//   gfdash/urls.py              -- "dash:*",         included at "dashboard/"
//   gfwrite/urls.py             -- "write:*",        included at "write/"
//   gfapi2/urls.py              -- "api2:*",         included at "api/2/"
//
// A table of constants can only be tested two ways that are worth anything:
// against the upstream it mirrors (above), and against the invariants the
// consumers rely on (below). Re-stating a literal from routes.ts back at
// itself would prove nothing, so nothing here does that.

// Every name the tables know about, in the order url() would look them up.
const ALL_NAMES = [...Object.keys(ROUTES), ...Object.keys(PARAMETERISED)];

// A path is "file-like" if its last segment carries an extension. Django's
// APPEND_SLASH redirects a directory-style URL that arrives without its
// trailing slash, so only these may legitimately end without one.
const isFileLike = (path: string) => /\.[a-z0-9]+$/.test(path);

// Indexing a Record<string, ...> yields `| undefined` under this repo's
// noUncheckedIndexedAccess, so calling a builder straight off the table does
// not typecheck. This also makes a DELETED route name fail as "no route
// named x" rather than as a bare TypeError, which matters because the whole
// point of these tests is to catch names disappearing from the table.
function param(name: string, ...args: string[]): string {
  const builder = PARAMETERISED[name];
  if (builder === undefined) throw new Error(`PARAMETERISED has no route named "${name}"`);
  return builder(...args);
}

describe("ROUTES", () => {
  it("reverses the root app's names to the paths givefood/urls.py declares", () => {
    // All of these come from the i18n_patterns block in givefood/urls.py,
    // which is declared with prefix_default_language=False -- hence no "/en"
    // anywhere in the table; English is the bare path and urlForLocale only
    // adds a prefix for other languages.
    expect(ROUTES.index).toBe("/"); // path("", ...)
    expect(ROUTES.about_us).toBe("/about-us/");
    expect(ROUTES.apps).toBe("/apps/");
    expect(ROUTES.flag).toBe("/flag/");
    expect(ROUTES.donate).toBe("/donate/");
    expect(ROUTES.annual_report_index).toBe("/annual-reports/");
    expect(ROUTES.human).toBe("/human/");
    expect(ROUTES.news).toBe("/news/");
    expect(ROUTES.bot).toBe("/bot/");
    expect(ROUTES.register_foodbank).toBe("/register-foodbank/");
    expect(ROUTES.manifest).toBe("/manifest.json");
    expect(ROUTES.sitemap).toBe("/sitemap.xml");
    // ...and these from the "Untranslated pages" list below it.
    expect(ROUTES.privacy).toBe("/privacy/");
    expect(ROUTES.whatsapp_hook).toBe("/whatsapp_hook/"); // underscore, not a hyphen
    expect(ROUTES.md_index).toBe("/md/");
    expect(ROUTES.md_sitemap).toBe("/md/sitemap.xml");
  });

  it("keeps the /needs/ index names on gfwfbn's own spellings", () => {
    // gfwfbn/urls/i18n.py, included at "needs/". "getlocation" is one word
    // in Django -- a well-meaning "get-location" here would 404 the location
    // lookup the /needs/ page's postcode box posts to.
    expect(ROUTES["wfbn:index"]).toBe("/needs/");
    expect(ROUTES["wfbn:get_location"]).toBe("/needs/getlocation/");
    expect(ROUTES["wfbn:rss"]).toBe("/needs/rss.xml");
    expect(ROUTES["wfbn:geojson"]).toBe("/needs/geo.json");
    expect(ROUTES["wfbn:constituencies"]).toBe("/needs/in/constituencies/");
    // gfwfbn/urls/generic.py -- also mounted at "needs/", so it shares the
    // prefix despite being a different namespace and a different urls file.
    expect(ROUTES["wfbn-generic:webpush_config"]).toBe("/needs/webpush/config/");
  });

  it("mirrors gfdash/urls.py, including the paths that do not match their name", () => {
    // The dashboard is the densest part of the table and several of its
    // route names do NOT predict their path. These are the ones where a
    // reasonable guess is wrong, so they are the ones worth pinning:
    expect(ROUTES["dash:index"]).toBe("/dashboard/");
    // named weekly_itemcount, but the URL says "items-requested-weekly"
    expect(ROUTES["dash:weekly_itemcount"]).toBe("/dashboard/items-requested-weekly/");
    expect(ROUTES["dash:weekly_itemcount_year"]).toBe("/dashboard/items-requested-weekly/by-year/");
    // tt_* lives under a "trusselltrust/" segment, not a "tt/" one
    expect(ROUTES["dash:tt_old_data"]).toBe("/dashboard/trusselltrust/old-data/");
    expect(ROUTES["dash:tt_most_requested_items"]).toBe("/dashboard/trusselltrust/most-requested-items/");
    // supermarkets is nested under donationpoints/
    expect(ROUTES["dash:supermarkets"]).toBe("/dashboard/donationpoints/supermarkets/");
    // price_per_* splits after "price-per/", it is not "price-per-kg/"
    // (gfdash/urls.py keeps "price-per-kg/" only as a permanent redirect)
    expect(ROUTES["dash:price_per_kg"]).toBe("/dashboard/price-per/kg/");
    expect(ROUTES["dash:price_per_calorie"]).toBe("/dashboard/price-per/calorie/");
    expect(ROUTES["dash:price_per_item_category"]).toBe("/dashboard/price-per/item-category/");
    // and the plain ones, for completeness of the ported set
    expect(ROUTES["dash:most_requested_items"]).toBe("/dashboard/most-requested-items/");
    expect(ROUTES["dash:most_excess_items"]).toBe("/dashboard/most-excess-items/");
    expect(ROUTES["dash:item_categories"]).toBe("/dashboard/item-categories/");
    expect(ROUTES["dash:item_groups"]).toBe("/dashboard/item-groups/");
    expect(ROUTES["dash:articles"]).toBe("/dashboard/articles/");
    expect(ROUTES["dash:beautybanks"]).toBe("/dashboard/beautybanks/");
    expect(ROUTES["dash:excess"]).toBe("/dashboard/excess/");
    expect(ROUTES["dash:foodbanks_found"]).toBe("/dashboard/foodbanks-found/");
    expect(ROUTES["dash:bean_pasta_index"]).toBe("/dashboard/bean-pasta-index/");
    expect(ROUTES["dash:charity_income_expenditure"]).toBe("/dashboard/charity-income-expenditure/");
    expect(ROUTES["dash:heatmap"]).toBe("/dashboard/heatmap/");
  });

  it("mounts api2 at /api/2/ and write at /write/", () => {
    // givefood/urls.py's "Untranslated apps" block: gfapi2 is included twice,
    // at "api/2/" under the "api2" namespace and at "api/" unnamespaced. The
    // namespaced mount is the one reverse() resolves for "api2:*", so /api/2/
    // is right and a bare /api/ would be reversing the wrong include.
    expect(ROUTES["api2:index"]).toBe("/api/2/");
    expect(ROUTES["api2:docs"]).toBe("/api/2/docs/");
    expect(ROUTES["write:index"]).toBe("/write/");
  });

  it("gives every route an absolute path", () => {
    // urlForLocale() builds a prefixed URL as `/${locale}${path}`. A value
    // that lost its leading slash would come out of a Welsh page as
    // "/cyneeds/" -- a 404 that only appears in the non-English locales, i.e.
    // the ones least likely to be clicked through before release.
    for (const [name, path] of Object.entries(ROUTES)) {
      expect(path, `ROUTES["${name}"] must be an absolute path`).toMatch(/^\//);
      expect(path, `ROUTES["${name}"] must not contain a doubled slash`).not.toMatch(/\/\//);
    }
  });

  it("ends every non-file path with a slash, as Django's APPEND_SLASH expects", () => {
    // Django redirects "/about-us" to "/about-us/". Emitting the unslashed
    // form in an internal link costs a 301 on every click and breaks the
    // exact-match cache keys the Worker builds from the path, so the table
    // must always carry the canonical trailing slash.
    const unslashed = Object.entries(ROUTES)
      .filter(([, path]) => !path.endsWith("/") && !isFileLike(path))
      .map(([name]) => name);
    expect(unslashed).toEqual([]);
    // The file-like exceptions are a closed set today; if this list grows,
    // check the new entry really is a file and not a forgotten slash.
    const files = Object.entries(ROUTES)
      .filter(([, path]) => !path.endsWith("/"))
      .map(([, path]) => path)
      .sort();
    expect(files).toEqual(["/manifest.json", "/md/sitemap.xml", "/needs/geo.json", "/needs/rss.xml", "/sitemap.xml"]);
  });

  it("never maps two route names onto the same path", () => {
    // Django's reverse() gives each name its own URL; two names sharing a
    // path here is a copy-paste slip, and the symptom is silent -- url()
    // returns a real, working page, just the wrong one. Django does register
    // several names against the SAME VIEW (dash:most_requested_items and
    // dash:tt_most_requested_items both call most_requested_items) but each
    // still has a distinct path, so this holds upstream too.
    const byPath = new Map<string, string[]>();
    for (const [name, path] of Object.entries(ROUTES)) {
      byPath.set(path, [...(byPath.get(path) ?? []), name]);
    }
    const collisions = [...byPath].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
  });

  it("shares no name with PARAMETERISED", () => {
    // url() in ./index.ts dispatches on ARITY: it consults PARAMETERISED only
    // when args were passed, and falls back to ROUTES otherwise. A name in
    // both tables would therefore resolve to two different paths depending on
    // how the caller happened to invoke it -- the kind of bug that survives
    // review because both call sites look correct in isolation.
    //
    // `in` rather than Object.hasOwn() on purpose: build() reaches the table
    // with a plain `PARAMETERISED[name]` index, which walks the prototype
    // chain, so `in` is the lookup that actually shadows. See the
    // inherited-key test below for why that distinction is not academic.
    const overlap = Object.keys(ROUTES).filter((name) => name in PARAMETERISED);
    expect(overlap).toEqual([]);
  });

  it("resolves inherited Object.prototype keys, so no route may be named after one", () => {
    // SUSPECTED BUG, pinned rather than fixed. Both tables are plain object
    // literals, so every Object.prototype member is a live "route name":
    // build() in ./index.ts guards with `if (path === undefined) throw` and
    // `if (parameterised) return parameterised(...args)`, and neither guard
    // fires for a name the prototype supplies. url("constructor") therefore
    // returns the Object function where its own error message promises a
    // throw, and url("toString", "x") calls Object.prototype.toString.
    //
    // Not hypothetical plumbing: url() IS called with a non-literal name --
    // routes/public/md.ts loops SITEMAP_URL_NAMES and md/sitemap.njk loops
    // url_names -- so the name is data, and data is what drifts.
    //
    // This is also the one hazard every other test in this file is blind to,
    // which is why it needs asserting by hand: Object.keys() omits inherited
    // keys, so all the table-walking loops above never see these names.
    expect(Object.keys(ROUTES)).not.toContain("toString");
    expect(ROUTES.toString).not.toBeUndefined(); // ...yet the lookup succeeds
    expect(typeof PARAMETERISED.constructor).toBe("function");
    // Every Object.prototype member behaves the same way, so spell out the
    // three a real route name could plausibly collide with. Each looks like a
    // hit to build() and like a non-route to Object.keys() at the same time.
    for (const inherited of ["toString", "valueOf", "constructor"]) {
      expect(inherited in ROUTES, `"${inherited}" resolves through the prototype`).toBe(true);
      expect(Object.hasOwn(ROUTES, inherited), `"${inherited}" is not a real route`).toBe(false);
    }
    // If the tables are ever hardened -- Object.create(null), or a hasOwn()
    // guard in build() -- this is the test that should change, deliberately.
    expect(Object.getPrototypeOf(ROUTES)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(PARAMETERISED)).toBe(Object.prototype);
  });
});

describe("PARAMETERISED", () => {
  it("builds the foodbank pages exactly as gfwfbn/urls/i18n.py reverses them", () => {
    expect(param("wfbn:foodbank", "bristol")).toBe("/needs/at/bristol/");
    expect(param("wfbn:foodbank_locations", "bristol")).toBe("/needs/at/bristol/locations/");
    expect(param("wfbn:foodbank_donationpoints", "bristol")).toBe("/needs/at/bristol/donationpoints/");
    expect(param("wfbn:foodbank_news", "bristol")).toBe("/needs/at/bristol/news/");
    expect(param("wfbn:foodbank_charity", "bristol")).toBe("/needs/at/bristol/charity/");
    expect(param("wfbn:foodbank_nearby", "bristol")).toBe("/needs/at/bristol/nearby/");
    expect(param("wfbn:foodbank_rss", "bristol")).toBe("/needs/at/bristol/rss.xml");
    expect(param("wfbn:foodbank_geojson", "bristol")).toBe("/needs/at/bristol/geo.json");
    expect(param("wfbn:foodbank_map", "bristol")).toBe("/needs/at/bristol/map.png");
    // Constituencies: note the SINGULAR "constituency" segment on the detail
    // page and feed, against the plural "constituencies" index in ROUTES --
    // gfwfbn/urls/i18n.py registers a redirect from the plural detail form
    // precisely because the two are so easy to confuse.
    expect(param("wfbn:constituency", "cities-of-london-and-westminster")).toBe(
      "/needs/in/constituency/cities-of-london-and-westminster/",
    );
    expect(param("wfbn:constituency_geojson", "hackney-south")).toBe(
      "/needs/in/constituency/hackney-south/geo.json",
    );
  });

  it("orders the two-argument routes slug-then-child, matching Django's kwargs", () => {
    // Django names these <slug:slug>/<slug:locslug> and
    // <slug:slug>/donationpoint/<slug:dpslug>. If the two arguments were ever
    // transposed the result is still a well-formed /needs/at/x/y/ URL, so it
    // fails as a 404 at request time rather than anywhere near the mistake.
    // Distinguishable arguments here make a transposition visible.
    expect(param("wfbn:foodbank_location", "bristol", "easton-centre")).toBe(
      "/needs/at/bristol/easton-centre/",
    );
    expect(param("wfbn:foodbank_location_geojson", "bristol", "easton-centre")).toBe(
      "/needs/at/bristol/easton-centre/geo.json",
    );
    expect(param("wfbn:foodbank_location_map", "bristol", "easton-centre")).toBe(
      "/needs/at/bristol/easton-centre/map.png",
    );
    expect(param("wfbn:foodbank_donationpoint", "bristol", "tesco-brislington")).toBe(
      "/needs/at/bristol/donationpoint/tesco-brislington/",
    );
    expect(param("wfbn:foodbank_donationpoint_openinghours", "bristol", "tesco-brislington")).toBe(
      "/needs/at/bristol/donationpoint/tesco-brislington/openinghours/",
    );
  });

  it("keeps the wfbn-generic image and hit routes unprefixed under /needs/", () => {
    // gfwfbn/urls/generic.py, included at "needs/" BEFORE i18n_patterns in
    // givefood/urls.py. Same /needs/at/<slug>/ shape as the i18n namespace,
    // different translation behaviour -- see the I18N_SCOPED tests below.
    expect(param("wfbn-generic:foodbank_hit", "bristol")).toBe("/needs/at/bristol/hit/");
    expect(param("wfbn-generic:foodbank_photo", "bristol")).toBe("/needs/at/bristol/photo.jpg");
    expect(param("wfbn-generic:foodbank_favicon", "bristol")).toBe("/needs/at/bristol/favicon.png");
    expect(param("wfbn-generic:foodbank_location_photo", "bristol", "easton-centre")).toBe(
      "/needs/at/bristol/easton-centre/photo.jpg",
    );
    expect(param("wfbn-generic:foodbank_donationpoint_photo", "bristol", "tesco-brislington")).toBe(
      "/needs/at/bristol/donationpoint/tesco-brislington/photo.jpg",
    );
    expect(param("wfbn-generic:webpush_subscribe", "bristol")).toBe("/needs/webpush/subscribe/bristol/");
    expect(param("wfbn-generic:webpush_unsubscribe", "bristol")).toBe("/needs/webpush/unsubscribe/bristol/");
  });

  it("puts the /md/ mirror at exactly /md + the /needs/ path", () => {
    // gfwfbn/urls/md.py duplicates the eight page patterns from i18n.py and
    // givefood/urls.py mounts it at "md/needs/". That means the mirror is
    // derivable, not independent: any wfbn-md path that stops agreeing with
    // its wfbn twin means one of the two was edited alone.
    const mirrored: Array<[string, string, string[]]> = [
      ["wfbn-md:md_foodbank", "wfbn:foodbank", ["bristol"]],
      ["wfbn-md:md_foodbank_locations", "wfbn:foodbank_locations", ["bristol"]],
      ["wfbn-md:md_foodbank_donationpoints", "wfbn:foodbank_donationpoints", ["bristol"]],
      ["wfbn-md:md_foodbank_news", "wfbn:foodbank_news", ["bristol"]],
      ["wfbn-md:md_foodbank_charity", "wfbn:foodbank_charity", ["bristol"]],
      ["wfbn-md:md_foodbank_nearby", "wfbn:foodbank_nearby", ["bristol"]],
      ["wfbn-md:md_foodbank_location", "wfbn:foodbank_location", ["bristol", "easton-centre"]],
      ["wfbn-md:md_foodbank_donationpoint", "wfbn:foodbank_donationpoint", ["bristol", "tesco-brislington"]],
    ];
    for (const [mdName, wfbnName, args] of mirrored) {
      expect(param(mdName, ...args), `${mdName} should mirror ${wfbnName}`).toBe(
        `/md${param(wfbnName, ...args)}`,
      );
    }
    // Spelled out once, so the test is not purely relative to its neighbour.
    expect(param("wfbn-md:md_foodbank_location", "bristol", "easton-centre")).toBe(
      "/md/needs/at/bristol/easton-centre/",
    );
  });

  it("reverses the write app, including the route with no Django ancestor", () => {
    // gfwrite/urls.py, mounted at "write/": the email flow is nested under
    // the constituency, not parallel to it.
    expect(param("write:constituency", "stroud")).toBe("/write/to/stroud/");
    expect(param("write:email", "stroud")).toBe("/write/to/stroud/email/");
    expect(param("write:send", "stroud")).toBe("/write/to/stroud/email/send/");
    expect(param("write:done", "stroud")).toBe("/write/to/stroud/email/done/");
    // write:constituency_by_code is new in this port (PLAN.md 6.9 R7) and
    // takes an ONS PCON24CD, not a slug -- the map's click handler uses it to
    // avoid reimplementing Django's slugify() in browser JS. Its path must
    // NOT collide with write:constituency's "/write/to/<slug>/" space, or a
    // constituency whose slug happened to look like a code would shadow it.
    expect(param("write:constituency_by_code", "E14001063")).toBe("/write/to-by-code/E14001063/");
    expect(param("write:constituency_by_code", "E14001063")).not.toMatch(/^\/write\/to\//);
  });

  it("accepts every value Django's choice regexes allow for updates and deliveries", () => {
    // gfwfbn/urls/i18n.py restricts the action to (subscribe|confirm|unsubscribe)
    // and gfdash/urls.py the metric to (count|items|weight|calories). The port
    // does not enforce either, so these assert the three/four real values
    // round-trip -- the enforcement is checked in the divergence test below.
    for (const action of ["subscribe", "confirm", "unsubscribe"]) {
      expect(param("wfbn:updates", "bristol", action)).toBe(`/needs/at/bristol/updates/${action}/`);
    }
    for (const metric of ["count", "items", "weight", "calories"]) {
      expect(param("dash:deliveries", metric)).toBe(`/dashboard/deliveries/${metric}/`);
    }
  });

  it("reverses the four root-level parameterised routes", () => {
    // country/country_geojson and annual_report are re_path patterns at the
    // very top level of givefood/urls.py, which is why country("scotland")
    // and annual_report("2024") produce the same "/<x>/" shape. Django keeps
    // them apart by regex (a country name vs a year); this table cannot, so
    // callers must pick the right name -- pinned here so the shape is at
    // least a deliberate, documented collision rather than a surprise.
    expect(param("country", "scotland")).toBe("/scotland/");
    expect(param("country_geojson", "northern-ireland")).toBe("/northern-ireland/geo.json");
    expect(param("annual_report", "2024")).toBe("/2024/");
    expect(param("country", "2024")).toBe(param("annual_report", "2024"));
    expect(param("frag", "cookie-banner")).toBe("/frag/cookie-banner/");
    // gfapi2/urls.py, under the namespaced "api/2/" mount.
    expect(param("api2:foodbank", "bristol")).toBe("/api/2/foodbank/bristol/");
    expect(param("api2:constituency", "stroud")).toBe("/api/2/constituency/stroud/");
  });

  it("interpolates arguments verbatim -- no escaping and no validation (a divergence)", () => {
    // DOCUMENTED DIVERGENCE from Django. reverse() checks the argument
    // against the converter/regex and raises NoReverseMatch if it does not
    // match, and quotes what it does accept. These are plain template
    // literals: they never throw, never encode, and will happily build a URL
    // Django's own resolver would refuse to match. Callers are therefore
    // responsible for passing an already-slugified value.
    //
    // Pinned as current behaviour, not endorsed: if validation or encoding is
    // ever added, these assertions are the ones that should change.
    expect(param("wfbn:foodbank", "Not A Slug")).toBe("/needs/at/Not A Slug/");
    // Surrounding whitespace is kept, not trimmed. Cheap to assert and the
    // only thing standing between here and a silent .trim() creeping into a
    // builder: every other argument in this file is already tight, so a trim
    // would be a no-op against all of them and the change would look free.
    expect(param("wfbn:foodbank", " bristol ")).toBe("/needs/at/ bristol /");
    expect(param("wfbn:foodbank", "a/b")).toBe("/needs/at/a/b/"); // a slash escapes the segment
    expect(param("wfbn:foodbank", "é")).toBe("/needs/at/é/"); // not percent-encoded
    // The slash case is worse than "wrong path": one route can impersonate
    // another. A slug carrying a slash makes the one-argument foodbank
    // builder emit a byte-identical path to the two-argument location
    // builder, so the resulting link resolves to a real page under a route
    // the caller never named.
    expect(param("wfbn:foodbank", "a/b")).toBe(param("wfbn:foodbank_location", "a", "b"));
    // No Unicode normalisation either, so the two spellings of a name with
    // an accent -- precomposed U+00E9 against "e" + combining acute U+0301 --
    // are different paths, hence different cache keys and two entries for one
    // foodbank. Written as escapes on purpose: as literal glyphs the two
    // arguments below look identical in every editor, which is exactly the
    // failure mode this pins.
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    expect(nfc).not.toBe(nfd); // guards the test itself against a paste that flattened them
    expect(param("wfbn:foodbank", nfc)).not.toBe(param("wfbn:foodbank", nfd));
    expect(param("wfbn:foodbank", nfd)).toBe("/needs/at/cafe\u0301/");
    // Nothing truncates, at any length: the whole slug reaches the href and
    // the cache key built from it.
    const long = "x".repeat(4096);
    expect(param("wfbn:foodbank", long)).toBe("/needs/at/" + long + "/");
    // Values Django's choice regexes would reject outright:
    expect(param("wfbn:updates", "bristol", "delete")).toBe("/needs/at/bristol/updates/delete/");
    expect(param("dash:deliveries", "pallets")).toBe("/dashboard/deliveries/pallets/");
    // ...and a year outside annual_report's 2019-2025 alternation.
    expect(param("annual_report", "1999")).toBe("/1999/");
  });

  it("does not throw on empty, missing or surplus arguments", () => {
    // The signature is (...args: string[]) => string, so TypeScript cannot
    // catch an arity mistake at a call site. These record what actually
    // happens instead, because the failure mode matters: a dropped second
    // argument produces the literal string "undefined" INSIDE a valid-looking
    // URL, which reads as a real slug in a log line or a Link header.
    expect(param("wfbn:foodbank", "")).toBe("/needs/at//");
    // Deliberately calling a two-argument route with one argument.
    expect(param("wfbn:foodbank_location", "bristol")).toBe("/needs/at/bristol/undefined/");
    // ...and calling a one-argument route with none at all, which is what a
    // template that forgot `{{ url('wfbn:foodbank', foodbank.slug) }}`'s
    // second half produces. Django raises NoReverseMatch here; this builds a
    // URL that 404s at request time instead.
    expect(param("wfbn:foodbank")).toBe("/needs/at/undefined/");
    // A two-argument route called with none at all fills BOTH segments, which
    // is the shape that turns up in logs as a plausible location page.
    expect(param("wfbn:foodbank_location")).toBe("/needs/at/undefined/undefined/");
    // An empty SECOND argument is the mirror of the "//" case below, but
    // benign by comparison: it doubles a slash mid-path rather than at the
    // root, so it stays same-origin and merely 404s.
    expect(param("wfbn:foodbank_location", "bristol", "")).toBe("/needs/at/bristol//");
    expect(param("wfbn:updates", "bristol", "")).toBe("/needs/at/bristol/updates//");
    // Surplus arguments are ignored rather than appended.
    expect(param("wfbn:foodbank", "bristol", "ignored")).toBe("/needs/at/bristol/");
  });

  it("stringifies whatever it is handed, because the builders are template literals", () => {
    // Every consumer of these tables is JS, not TypeScript-checked at the
    // boundary: handler code reads slugs and years out of KV/JSON, where a
    // year arrives as a NUMBER and a missing field arrives as null. The
    // builders are `${x}` interpolations, so they coerce silently rather than
    // rejecting -- worth pinning because the number case is not a bug (it
    // produces the right URL) while the null case produces a plausible-looking
    // "/needs/at/null/" that no test of the happy path would ever surface.
    const loose = (name: string, ...args: unknown[]) => param(name, ...(args as string[]));
    expect(loose("annual_report", 2024)).toBe("/2024/"); // numeric year is fine
    expect(loose("dash:deliveries", 0)).toBe("/dashboard/deliveries/0/"); // 0 is not falsy-dropped
    expect(loose("wfbn:foodbank", null)).toBe("/needs/at/null/");
    expect(loose("wfbn:foodbank", undefined)).toBe("/needs/at/undefined/");
    expect(loose("annual_report", Number.NaN)).toBe("/NaN/");
    // -0 and 0 are distinct values that String() flattens to the same digit,
    // so a metric computed as `-count` when count is 0 still reaches the right
    // dashboard rather than a "/-0/" that 404s. Recorded because Object.is
    // would tell you otherwise and someone will eventually reach for it.
    expect(loose("dash:deliveries", -0)).toBe("/dashboard/deliveries/0/");
    expect(Object.is(-0, 0)).toBe(false); // ...the value really is distinct
    // Large numbers do NOT survive: past 1e21 String() switches to exponent
    // notation, so an id read out of JSON as a number silently becomes a path
    // segment with a "+" in it. Years are far below this; ids need not be.
    expect(loose("annual_report", 1e21)).toBe("/1e+21/");
    // A single-element array stringifies to its one member, so a field that
    // arrives wrapped in an array from KV/JSON produces a CORRECT URL and
    // hides the type error entirely -- until a second element appears.
    expect(loose("wfbn:foodbank", ["bristol"])).toBe("/needs/at/bristol/");
    expect(loose("wfbn:foodbank", ["bristol", "bath"])).toBe("/needs/at/bristol,bath/");
  });

  it("builds a protocol-relative '//' when a root-level route gets an empty argument", () => {
    // SUSPECTED BUG, pinned rather than fixed. country/country_geojson/
    // annual_report are the only builders whose argument is the FIRST path
    // segment, so an empty value collapses them to "//" -- which a browser
    // resolving an href reads as a scheme-relative URL, not as the site root.
    // Every other builder degrades to a harmless internal "//" mid-path.
    //
    // Note this is exactly the case the "must not contain a doubled slash"
    // loop below cannot see: it exercises the builders with non-empty
    // placeholder arguments, so the invariant it checks is a property of the
    // TEMPLATES, not of what real (possibly empty) data produces.
    expect(param("country", "")).toBe("//");
    expect(param("annual_report", "")).toBe("//");
    expect(param("country_geojson", "")).toBe("//geo.json");
    // ...versus the same mistake on a nested route, which stays same-origin.
    expect(param("wfbn:foodbank", "")).toBe("/needs/at//");
  });

  it("passes through characters that change what the URL means", () => {
    // Continues the no-escaping divergence above with the cases that are not
    // merely wrong but dangerous. Django's <slug:...> converter matches
    // [-a-zA-Z0-9_]+ only, so reverse() would raise NoReverseMatch on every
    // one of these; the port emits them into hrefs, Link headers and cache
    // keys verbatim. Pinned so that adding encodeURIComponent() later is a
    // deliberate, visible change rather than a silent one.
    expect(param("wfbn:foodbank", "a?b=c")).toBe("/needs/at/a?b=c/"); // becomes a query string
    expect(param("wfbn:foodbank", "a#b")).toBe("/needs/at/a#b/"); // becomes a fragment
    expect(param("wfbn:foodbank", "..")).toBe("/needs/at/../"); // resolves up a level
    expect(param("wfbn:foodbank", "a%2Fb")).toBe("/needs/at/a%2Fb/"); // no double-encoding either
    // The sharpest one, because of WHERE these strings go. routes.ts's own D7
    // note says two of these builders exist to fill "the Link preload header",
    // and locationDetail.ts still emits one. A CR/LF surviving interpolation
    // therefore reaches a response header unescaped, which is header
    // injection, not merely a 404. Nothing here strips or rejects it.
    const crlf = param("wfbn:foodbank_location_map", "bristol", "x\r\nX-Injected: 1");
    expect(crlf).toBe("/needs/at/bristol/x\r\nX-Injected: 1/map.png");
    expect(crlf).toContain("\r\n");
    // A bare newline survives too, and so does a NUL -- that one matters
    // separately because some log and header writers treat it as a string
    // terminator, so everything after it vanishes downstream rather than
    // being escaped or rejected. Built with fromCharCode because a literal
    // NUL in a source file is invisible to every reviewer.
    expect(param("wfbn:foodbank", "a\nb")).toBe("/needs/at/a\nb/");
    const nul = String.fromCharCode(0);
    expect(param("wfbn:foodbank", `a${nul}b`)).toBe(`/needs/at/a${nul}b/`);
    // country's Django ancestor is a re_path restricted to the four UK
    // nations (givefood/urls.py); the table imposes no such alternation.
    expect(param("country", "france")).toBe("/france/");
  });

  it("never hardcodes the value it was given an argument for", () => {
    // The table is ~40 near-identical one-line arrow functions, which is
    // precisely the shape that gets extended by copy-paste. A builder that
    // kept its neighbour's body -- `() => "/needs/at/bristol/news/"` -- would
    // satisfy EVERY literal assertion in this file, because they all use
    // "bristol" as the slug. This is the test that catches that class of slip:
    // vary the argument and the path must vary with it.
    for (const name of Object.keys(PARAMETERISED)) {
      const withA = param(name, "aaa", "child");
      const withB = param(name, "bbb", "child");
      expect(withA, `PARAMETERISED["${name}"] must interpolate its first argument`).toContain("aaa");
      expect(withB, `PARAMETERISED["${name}"] must interpolate its first argument`).toContain("bbb");
      expect(withA, `PARAMETERISED["${name}"] must depend on its first argument`).not.toBe(withB);
    }
  });

  it("consumes a second argument for exactly the routes Django declares two kwargs for", () => {
    // Arity is a real Django-parity property: reverse() raises unless the
    // kwargs match the pattern exactly. Nothing else here checks it, and the
    // (...args: string[]) signature means TypeScript never will. Derived by
    // probing rather than by reading the source, so a builder that silently
    // stopped using its locslug (leaving /needs/at/bristol/ where the location
    // page should be) drops out of this list and fails.
    //
    // The list is every two-group pattern across gfwfbn/urls/i18n.py,
    // gfwfbn/urls/generic.py and gfwfbn/urls/md.py -- <slug:slug> paired with
    // <slug:locslug>, <slug:dpslug>, or updates' (?P<action>...) group.
    const twoArg = Object.keys(PARAMETERISED)
      .filter((name) => param(name, "AAA", "BBB").includes("BBB"))
      .sort();
    expect(twoArg).toEqual([
      "wfbn-generic:foodbank_donationpoint_photo",
      "wfbn-generic:foodbank_location_photo",
      "wfbn-md:md_foodbank_donationpoint",
      "wfbn-md:md_foodbank_location",
      "wfbn:foodbank_donationpoint",
      "wfbn:foodbank_donationpoint_openinghours",
      "wfbn:foodbank_location",
      "wfbn:foodbank_location_geojson",
      "wfbn:foodbank_location_map",
      "wfbn:updates",
    ]);
  });

  it("reverses two names onto one path only where Django keeps them apart by regex", () => {
    // The ROUTES table gets a no-collisions test; this is its counterpart, and
    // it cannot be a flat "no collisions" because there is exactly one real
    // one. country and annual_report are both re_path patterns at the top
    // level of givefood/urls.py -- Django distinguishes /scotland/ from /2024/
    // by the alternations in the regexes, which this table has no way to
    // express. Pinning the collision SET (rather than asserting the one pair
    // equals itself) means a second, undocumented collision fails here.
    const byPath = new Map<string, string[]>();
    for (const name of Object.keys(PARAMETERISED)) {
      const path = param(name, "aaa", "bbb");
      byPath.set(path, [...(byPath.get(path) ?? []), name]);
    }
    const collisions = [...byPath].filter(([, names]) => names.length > 1).map(([, names]) => names.sort());
    expect(collisions).toEqual([["annual_report", "country"]]);
  });

  it("gives a path an extension only for the feeds and images Django serves as files", () => {
    // The trailing-slash loop below skips anything file-like, so a new route
    // added as "/needs/at/<slug>/openinghours" -- slash forgotten, no
    // extension -- fails there, but one added as ".../summary.txt" would sail
    // through unexamined. This closes that hole from the other side: the set
    // of extension-bearing routes is fixed, and each one below is a Django
    // pattern that genuinely ends in a filename (rss.xml, geo.json, map.png,
    // photo.jpg, favicon.png).
    const files = Object.keys(PARAMETERISED)
      .filter((name) => isFileLike(param(name, "aaa", "bbb")))
      .sort();
    expect(files).toEqual([
      "country_geojson",
      "wfbn-generic:foodbank_donationpoint_photo",
      "wfbn-generic:foodbank_favicon",
      "wfbn-generic:foodbank_location_photo",
      "wfbn-generic:foodbank_photo",
      "wfbn:constituency_geojson",
      "wfbn:foodbank_geojson",
      "wfbn:foodbank_location_geojson",
      "wfbn:foodbank_location_map",
      "wfbn:foodbank_map",
      "wfbn:foodbank_rss",
    ]);
  });

  it("generates absolute paths under the same trailing-slash rule as ROUTES", () => {
    // Same reasoning as the ROUTES invariants: urlForLocale() concatenates
    // "/<locale>" onto whatever comes back, and Django redirects an unslashed
    // directory URL. Exercising every builder with two placeholder args also
    // proves none of them throws, whatever their real arity.
    for (const [name, build] of Object.entries(PARAMETERISED)) {
      const path = build("slug", "child");
      expect(path, `PARAMETERISED["${name}"] must build an absolute path`).toMatch(/^\//);
      expect(path, `PARAMETERISED["${name}"] must not contain a doubled slash`).not.toMatch(/\/\//);
      if (!isFileLike(path)) {
        expect(path, `PARAMETERISED["${name}"] must end with a slash`).toMatch(/\/$/);
      }
    }
  });
});

describe("I18N_SCOPED", () => {
  it("only names routes that actually exist", () => {
    // A typo here is silent in the worst possible way: urlForLocale() looks
    // the name up with Set.has(), misses, and returns the UNPREFIXED path.
    // The English site stays perfect and every Welsh/Irish/Gaelic page loses
    // its language prefix on that one link, dropping the visitor back into
    // English mid-journey.
    const unknown = [...I18N_SCOPED].filter((name) => !ALL_NAMES.includes(name));
    expect(unknown).toEqual([]);
  });

  it("excludes every wfbn-generic:* name, which routes.ts calls deliberate", () => {
    // givefood/urls.py registers gfwfbn.urls.generic BEFORE the i18n_patterns
    // block, so those URLs never carry a language prefix no matter what page
    // links to them. /cy/needs/at/bristol/photo.jpg does not exist; the photo
    // and hit endpoints must stay bare even when emitted by a Welsh page.
    const scopedGenerics = [...I18N_SCOPED].filter((name) => name.startsWith("wfbn-generic:"));
    expect(scopedGenerics).toEqual([]);
  });

  it("excludes the untranslated apps: dash, write, api2 and the /md/ mirror", () => {
    // All four sit in givefood/urls.py's "Untranslated apps" / "Markdown
    // versions" blocks, outside i18n_patterns. Prefixing one would produce a
    // 404 rather than a translation -- routes.ts states this for dash:*,
    // write:* and wfbn-md:* individually; this covers the whole namespace so
    // a newly-added sibling cannot slip through unclassified.
    const wronglyScoped = [...I18N_SCOPED].filter((name) =>
      /^(dash:|write:|api2:|wfbn-md:)/.test(name),
    );
    expect(wronglyScoped).toEqual([]);
  });

  it("scopes every wfbn:* name, because that whole include is inside i18n_patterns", () => {
    // givefood/urls.py mounts gfwfbn.urls.i18n at "needs/" INSIDE
    // i18n_patterns, so there is no such thing as an unprefixed-on-purpose
    // wfbn: route. Anything added to the tables under that namespace and left
    // out of this set is a bug by construction -- which is exactly how the
    // wfbn:foodbank_location_map / wfbn:foodbank_donationpoint_openinghours
    // omissions described in the D7 note came about.
    const unscoped = ALL_NAMES.filter((name) => name.startsWith("wfbn:") && !I18N_SCOPED.has(name));
    expect(unscoped).toEqual([]);
  });

  it("leaves exactly Django's untranslated root pages unscoped", () => {
    // The root app is the mixed one: most of its names live inside
    // i18n_patterns, four do not. routes.ts's header still warns that the
    // root-app names "aren't marked yet" -- they since were, so the whole
    // unnamespaced set is now classified and this asserts the split rather
    // than the leftovers. Each of the four below is on the "Untranslated
    // pages" list in givefood/urls.py:
    //   privacy/         -- the confirmed i18n_patterns exception
    //   whatsapp_hook/   -- a webhook, not a page
    //   md/, md/sitemap.xml -- the "Markdown versions" block
    const unnamespaced = ALL_NAMES.filter((name) => !name.includes(":"));
    const unscoped = unnamespaced.filter((name) => !I18N_SCOPED.has(name)).sort();
    expect(unscoped).toEqual(["md_index", "md_sitemap", "privacy", "whatsapp_hook"]);
  });

  it("scopes the names page.njk emits on every single page", () => {
    // Called out in routes.ts as previously-broken: the shared head/footer
    // calls these on EVERY render, including the foodbank pages already live
    // under /cy/, /ga/ and /gd/, and each one was dropping its prefix. human
    // in particular is the subscribe form's action on every foodbank page.
    // Spelled out individually because these are the regressions, not just
    // members of a namespace.
    for (const name of ["manifest", "flag", "apps", "annual_report_index", "human"]) {
      expect(I18N_SCOPED.has(name), `${name} must stay i18n-scoped`).toBe(true);
    }
    // sitemap.xml is inside i18n_patterns in Django (givefood/urls.py) while
    // md/sitemap.xml is not -- a genuinely asymmetric pair that looks like a
    // mistake at a glance.
    expect(I18N_SCOPED.has("sitemap")).toBe(true);
    expect(I18N_SCOPED.has("md_sitemap")).toBe(false);
  });
});

// routes.ts's header warns in both directions: the table must not lose a name
// urls.py has, and it must not invent one urls.py does not. Every test above
// checks a name the table already contains; these check the SHAPE of each
// namespace against its Django file, so a dropped or fabricated entry fails
// even though no assertion mentions it by name.
describe("namespace coverage against Django's urls.py", () => {
  const namesIn = (prefix: string) => ALL_NAMES.filter((name) => name.startsWith(prefix)).sort();

  it("keeps every namespace under the path its include() is mounted at", () => {
    // The mount points are stated at the top of this file and in routes.ts's
    // own block comments -- "included at needs/", "included at dashboard/" --
    // but nothing asserted them, so they were documentation rather than a
    // contract. A namespace is a whole app behind ONE include() in
    // givefood/urls.py: reverse() cannot produce a "dash:" URL outside
    // /dashboard/, so neither may this table.
    //
    // This is the invariant that survives the tables growing. The closed sets
    // below can only catch a name gfdash/md.py/gfwrite.py does not declare;
    // for the two namespaces that are still open subsets -- wfbn:* and
    // wfbn-generic:*, where a closed list would fight every future addition
    // and where this file cannot honestly enumerate upstream -- a new entry
    // dropped in at the wrong prefix is otherwise caught by nothing at all.
    const mounts: Array<[string, string]> = [
      ["wfbn:", "/needs/"], // gfwfbn/urls/i18n.py
      ["wfbn-generic:", "/needs/"], // gfwfbn/urls/generic.py, same mount
      ["wfbn-md:", "/md/needs/"], // gfwfbn/urls/md.py
      ["dash:", "/dashboard/"], // gfdash/urls.py
      ["write:", "/write/"], // gfwrite/urls.py
      ["api2:", "/api/2/"], // gfapi2/urls.py, the namespaced include
    ];
    for (const [prefix, mount] of mounts) {
      const names = namesIn(prefix);
      // Guard against the loop passing because a rename emptied the namespace.
      expect(names.length, `${prefix} should not be empty`).toBeGreaterThan(0);
      for (const name of names) {
        const path = Object.hasOwn(ROUTES, name) ? (ROUTES[name] as string) : param(name, "aaa", "bbb");
        expect(path, `"${name}" must live under ${mount}`).toMatch(
          new RegExp(`^${mount.replaceAll("/", "\\/")}`),
        );
      }
    }
    // The loop only constrains names that ALREADY carry a namespace prefix,
    // so it says nothing about the unnamespaced half of the table -- and /md/
    // is the one mount an unnamespaced name can plausibly wander into, since
    // md_index and md_sitemap legitimately live there. This pins who owns
    // /md/: the two root entries on givefood/urls.py's "Markdown versions"
    // list, plus gfwfbn/urls/md.py's eight, and nobody else.
    const mdPaths = ALL_NAMES.filter((name) => {
      const path = Object.hasOwn(ROUTES, name) ? (ROUTES[name] as string) : param(name, "aaa", "bbb");
      return path.startsWith("/md/") || path === "/md/";
    }).sort();
    expect(mdPaths).toEqual([
      "md_index",
      "md_sitemap",
      "wfbn-md:md_foodbank",
      "wfbn-md:md_foodbank_charity",
      "wfbn-md:md_foodbank_donationpoint",
      "wfbn-md:md_foodbank_donationpoints",
      "wfbn-md:md_foodbank_location",
      "wfbn-md:md_foodbank_locations",
      "wfbn-md:md_foodbank_nearby",
      "wfbn-md:md_foodbank_news",
    ]);
  });

  it("ports gfdash/urls.py in full -- every named pattern and nothing else", () => {
    // The dashboard is the one app the port covers completely, which makes it
    // the one place a closed set is honest. gfdash/urls.py declares 21 named
    // patterns (its 22nd entry is the price-per-kg/ RedirectView, which has no
    // name and so cannot be reversed). dash:deliveries lives in PARAMETERISED
    // because it is the only one with a capture group, hence ALL_NAMES here
    // rather than Object.keys(ROUTES).
    expect(namesIn("dash:")).toEqual([
      "dash:articles",
      "dash:bean_pasta_index",
      "dash:beautybanks",
      "dash:charity_income_expenditure",
      "dash:deliveries",
      "dash:excess",
      "dash:foodbanks_found",
      "dash:heatmap",
      "dash:index",
      "dash:item_categories",
      "dash:item_groups",
      "dash:most_excess_items",
      "dash:most_requested_items",
      "dash:price_per_calorie",
      "dash:price_per_item_category",
      "dash:price_per_kg",
      "dash:supermarkets",
      "dash:tt_most_requested_items",
      "dash:tt_old_data",
      "dash:weekly_itemcount",
      "dash:weekly_itemcount_year",
    ]);
  });

  it("ports gfwfbn/urls/md.py's eight patterns and no ninth", () => {
    // The /md/ mirror is closed upstream: md.py has exactly these eight, each
    // a duplicate of an i18n.py page pattern. A ninth wfbn-md: name here would
    // mean someone added a mirror page Django does not serve -- and the mirror
    // test above would not notice, because it only walks the pairs it lists.
    expect(namesIn("wfbn-md:")).toEqual([
      "wfbn-md:md_foodbank",
      "wfbn-md:md_foodbank_charity",
      "wfbn-md:md_foodbank_donationpoint",
      "wfbn-md:md_foodbank_donationpoints",
      "wfbn-md:md_foodbank_location",
      "wfbn-md:md_foodbank_locations",
      "wfbn-md:md_foodbank_nearby",
      "wfbn-md:md_foodbank_news",
    ]);
  });

  it("ports gfwrite/urls.py's five patterns plus the one route with no Django ancestor", () => {
    // gfwrite/urls.py is five patterns. The sixth name below is the port's
    // own (PLAN.md 6.9 R7). Asserting the set is how the "has no Django
    // equivalent" comment in routes.ts stays a statement about ONE route: if a
    // second unported name appears here the claim quietly stopped being true.
    expect(namesIn("write:")).toEqual([
      "write:constituency",
      "write:constituency_by_code",
      "write:done",
      "write:email",
      "write:index",
      "write:send",
    ]);
  });

  it("invents no api2 route -- gfapi2/urls.py is ported as a subset, not extended", () => {
    // Unlike dash/md/write, only 4 of gfapi2's 13 patterns are ported, so the
    // set is open at the bottom and a closed assertion would fight every
    // future addition. The half that still matters is the other direction:
    // /api/2/ is a published, versioned contract, so a name here that gfapi2
    // does not define would emit a documented-looking API URL that 404s.
    const djangoApi2 = [
      "index",
      "docs",
      "foodbanks",
      "foodbank",
      "foodbank_search",
      "locations",
      "location_search",
      "donationpoints",
      "donationpoint_search",
      "needs",
      "need",
      "constituencies",
      "constituency",
    ].map((name) => `api2:${name}`);
    const invented = namesIn("api2:").filter((name) => !djangoApi2.includes(name));
    expect(invented).toEqual([]);
  });
});
