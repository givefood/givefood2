import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { LOCALES, loadCatalogue, translate } from "@givefood/templates";
import { urlForLocale } from "@givefood/urls";
import realApp from "../index";
import { FOODBANK_FIELDS, fieldsByName, parseAdminFields } from "./adminFormFields";
import { COUNTRY_MAP_CONFIG, COUNTRY_MAPPING, COUNTRY_PLACEHOLDERS } from "./countries";
import type { CountryMapSettings } from "./countries";

// countries.ts is three lookup tables, which is exactly why it needs tests:
// nothing in it can fail loudly. Every way it can break is silent --
//
//   * a display name that no longer matches the `country` column returns an
//     EMPTY country page and an empty geo.json, because packages/db's
//     `SELECT * FROM foodbank WHERE country = ?` (foodbank.ts:274) is an
//     exact string match with no fallback;
//   * a key set that drifts between the three tables turns country.ts:58's
//     `COUNTRY_MAP_CONFIG[countryName]!` into "cannot read .lat of
//     undefined" -- a 500 on a top-level page;
//   * a reworded placeholder still renders, just always in English, because
//     it is used as a translation *key* at render time.
//
// So the tests below assert the cross-file agreements, not the literals in
// isolation. The Django tables are duplicated verbatim here on purpose --
// same reasoning as apiResponse.test.ts's DJANGO_ALLOWED_FORMATS: the module
// under test must not be allowed to supply its own expectations. For the
// same reason, every count/coverage guard below is derived from those
// hand-copied tables rather than from the module: a loop over
// `Object.values(COUNTRY_MAPPING)` passes vacuously if the export ever
// resolves to `{}`, which is precisely the regression worth catching.

// givefood/views.py:35-40, copied by hand from the Python source.
const DJANGO_COUNTRY_MAPPING: Record<string, string> = {
  scotland: "Scotland",
  england: "England",
  wales: "Wales",
  "northern-ireland": "Northern Ireland",
};

// givefood/views.py:44-65.
const DJANGO_COUNTRY_MAP_CONFIG: Record<string, CountryMapSettings> = {
  Scotland: { lat: 57.7, lng: -4, zoom: 6 },
  England: { lat: 53, lng: -1.8, zoom: 6 },
  Wales: { lat: 52.3, lng: -3.7, zoom: 7 },
  "Northern Ireland": { lat: 54.6, lng: -6.5, zoom: 7 },
};

// givefood/views.py:68-73, unwrapped from their `_()` calls -- the msgid is
// the argument, and the msgid is what this port stores.
const DJANGO_COUNTRY_PLACEHOLDERS: Record<string, string> = {
  Scotland: "e.g. EH12 5PJ or Glasgow",
  England: "e.g. HA9 0WS or Manchester",
  Wales: "e.g. CF10 1NS or Cardiff",
  "Northern Ireland": "e.g. BT12 6LW or Belfast",
};

const DJANGO_SLUG_COUNT = Object.keys(DJANGO_COUNTRY_MAPPING).length;
const DJANGO_COUNTRY_NAMES = Object.values(DJANGO_COUNTRY_MAPPING).sort();

// The country routes as the shipped Worker actually registers them
// (index.ts:405-411), read off the real Hono app rather than copied into
// this file. The copy is the thing to avoid: delete `wales` from index.ts
// and a hand-written pattern here still matches /wales/ happily, so this
// file would stay green while the live site 404s a page sitemap.xml goes on
// publishing. Importing index.ts pulls the whole Worker in and is why
// nothing else here does it -- but the router is the one thing that cannot
// be re-stated in a test and still mean anything. (No extra fragility: the
// catalogue tests at the bottom already need
// `pnpm --filter @givefood/templates run precompile` to have run.)
const COUNTRY_ROUTES = realApp.routes.filter((route) => route.path.includes(":countrySlug"));
const ROUTE_ALTERNATIONS = [...new Set(COUNTRY_ROUTES.map((route) => /:countrySlug\{([^}]*)\}/.exec(route.path)?.[1] ?? ""))];

// A standalone router with the shipped registrations and a handler that just
// echoes the param -- so a request exercises Hono's matching without a D1
// binding, and the assertions are about routing rather than about a 500.
function countryRouter(): Hono {
  const app = new Hono();
  for (const route of COUNTRY_ROUTES) app.get(route.path, (c) => c.text(c.req.param("countrySlug")!));
  return app;
}

describe("COUNTRY_MAPPING", () => {
  it("is Django's COUNTRY_MAPPING, slug for slug", () => {
    // givefood/views.py:35-40. The values are not free-form labels: they are
    // the strings sitting in every foodbank/foodbanklocation/
    // foodbankdonationpoint row's `country` column, so this equality is the
    // difference between a populated country page and an empty one.
    // toStrictEqual, not toEqual: toEqual ignores keys whose value is
    // undefined, so a fifth slug left half-deleted (`isle_of_man: undefined`)
    // would slip through a toEqual while still being enumerated by
    // Object.keys() into sitemap.xml.
    expect(COUNTRY_MAPPING).toStrictEqual(DJANGO_COUNTRY_MAPPING);
    // Two slugs pointing at one display name is the copy-paste slip this
    // catches: /wales/ would render the Welsh heading over England's rows.
    expect(new Set(Object.values(COUNTRY_MAPPING)).size).toBe(DJANGO_SLUG_COUNT);
  });

  it("keeps Django's dict order, because two sitemaps iterate it", () => {
    // sitemaps.ts:40 and md.ts:77 both emit one <loc> per key in iteration
    // order, and md.ts:108 hands the raw key array to the markdown sitemap
    // template. Sorting these keys "tidily" would silently reorder a public,
    // crawled document; Python 3.7+ dicts preserve insertion order too, so
    // the Django source's own order is the one to keep.
    expect(Object.keys(COUNTRY_MAPPING)).toEqual(["scotland", "england", "wales", "northern-ireland"]);
  });

  it("uses slugs that survive being pasted into a sitemap <loc> unescaped", () => {
    // sitemaps.ts:40 interpolates the key straight into `<url><loc>` with no
    // encoding, and urls.ts:104 straight into `/${countrySlug}/`. A key with
    // a space or a capital ("Northern Ireland") would therefore publish a URL
    // that is neither valid in the XML nor matched by the router -- and it
    // would look completely reasonable in the source of this module.
    for (const slug of Object.keys(COUNTRY_MAPPING)) {
      expect(encodeURIComponent(slug), `${slug} needs percent-encoding in a URL`).toBe(slug);
      expect(slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
    expect(Object.keys(COUNTRY_MAPPING)).toHaveLength(DJANGO_SLUG_COUNT);
  });

  it("only produces names the admin's country dropdown can actually write", () => {
    // The `country` column is populated from the admin form's select, whose
    // options come from givefood/const/general.py:4-13 (adminFormFields.ts's
    // COUNTRIES). If a display name here is not one of those options, no row
    // can ever hold it and the country page is permanently empty -- the kind
    // of break that shows as "no food banks in Wales", not as an error.
    const countryField = FOODBANK_FIELDS.find((field) => field.name === "country");
    const allowedColumnValues = countryField?.options ?? [];
    expect(allowedColumnValues.length).toBeGreaterThan(0); // guard: the field must still exist
    for (const displayName of Object.values(COUNTRY_MAPPING)) {
      expect(allowedColumnValues).toContain(displayName);
    }
    expect(Object.values(COUNTRY_MAPPING)).toHaveLength(DJANGO_SLUG_COUNT);
  });

  it("covers only the four home nations, not the crown dependencies", () => {
    // The admin dropdown really is wider than this table -- asserted, not
    // assumed, or the "only four" check below would be vacuously true on a
    // dropdown that also only offered four. Food banks in Douglas and St
    // Helier exist in the database and deliberately get no country page
    // (givefood/urls.py:33's regex lists four alternatives), so a
    // well-meaning "we support these too" addition here would mint sitemap
    // URLs that 404 -- see the routing tests below, which enforce the same
    // thing from the other end.
    const options = FOODBANK_FIELDS.find((field) => field.name === "country")?.options ?? [];
    for (const dependency of ["Isle of Man", "Jersey", "Guernsey"]) {
      expect(options, `${dependency} is no longer a storable country`).toContain(dependency);
    }
    expect(Object.keys(COUNTRY_MAPPING)).toHaveLength(DJANGO_SLUG_COUNT);
    expect(COUNTRY_MAPPING["isle-of-man"]).toBeUndefined();
    expect(COUNTRY_MAPPING["jersey"]).toBeUndefined();
    expect(COUNTRY_MAPPING["guernsey"]).toBeUndefined();
  });

  it("returns undefined for anything that is not one of the four slugs", () => {
    // country.ts:29 and buildGeojson.ts:216 both branch on a falsy lookup
    // (`return c.notFound()` / `return null`) rather than asserting. Those
    // guards are only meaningful if a miss is genuinely undefined, so pin
    // it -- including the case-sensitivity, since the slug arrives from a
    // URL path and "/Scotland/" is a URL a human will type.
    expect(COUNTRY_MAPPING["Scotland"]).toBeUndefined();
    expect(COUNTRY_MAPPING["ENGLAND"]).toBeUndefined();
    expect(COUNTRY_MAPPING["northern ireland"]).toBeUndefined();
    expect(COUNTRY_MAPPING["northern-ireland "]).toBeUndefined(); // a trailing space is not trimmed anywhere
    expect(COUNTRY_MAPPING["ireland"]).toBeUndefined();
    expect(COUNTRY_MAPPING["united-kingdom"]).toBeUndefined();
    expect(COUNTRY_MAPPING[""]).toBeUndefined();
  });

  it("is a plain object, so Object.prototype keys survive the falsy guard", () => {
    // Documenting current behaviour, not endorsing it: the tables are object
    // literals, not null-prototype maps, so a lookup of "toString" or
    // "constructor" returns an inherited function -- truthy, and it would
    // sail straight past `if (!countryName)` into a `country = <function>`
    // query. It gets worse one line later: COUNTRY_MAP_CONFIG["constructor"]
    // is truthy too, so country.ts:58's `!` yields a function whose .lat and
    // .zoom are undefined and JSON.stringify drops them, handing the map a
    // config with no centre. Unreachable today ONLY because both call sites
    // are behind index.ts's route param -- which is why the very next test
    // checks that the router really does refuse these names.
    expect(typeof COUNTRY_MAPPING["toString"]).toBe("function");
    expect(typeof COUNTRY_MAP_CONFIG["constructor"]).toBe("function");
    expect(JSON.stringify({ lat: (COUNTRY_MAP_CONFIG["constructor"] as unknown as CountryMapSettings).lat })).toBe("{}");
    // The safe lookup that is not fooled:
    expect(Object.hasOwn(COUNTRY_MAPPING, "toString")).toBe(false);
    expect(Object.hasOwn(COUNTRY_MAPPING, "scotland")).toBe(true);
  });

  it("holds exactly the slugs the shipped router will admit", () => {
    // Read off index.ts's own registrations (see COUNTRY_ROUTES above), so
    // this compares two files rather than this file with itself. The failure
    // it prevents runs both ways: a fifth country added to the table alone
    // gets published by sitemaps.ts:40 into a URL the router refuses, and a
    // country dropped from the table alone leaves a route whose handler
    // immediately c.notFound()s.
    expect(ROUTE_ALTERNATIONS, `index.ts's country routes disagree: ${ROUTE_ALTERNATIONS.join(" vs ")}`).toHaveLength(1);
    const admitted = ROUTE_ALTERNATIONS[0]!.split("|");
    // Sorted: the order inside the alternation has no effect on matching,
    // unlike the table's own key order (see the sitemap test above).
    expect([...admitted].sort()).toEqual(Object.keys(COUNTRY_MAPPING).sort());
  });

  it("is registered under every locale the site ships, not just unprefixed", () => {
    // index.ts:408-411 re-registers both country routes inside
    // `for (const locale of LOCALES)`. urlForLocale() prefixes country and
    // country_geojson for every non-en locale (routes.ts:182, 204), so
    // sitemap.xml rendered for /cy/ publishes /cy/scotland/. A locale added
    // to LOCALES but missed in that loop therefore publishes four URLs per
    // language that the router has never heard of.
    const registered = COUNTRY_ROUTES.map((route) => route.path);
    const pattern = `:countrySlug{${ROUTE_ALTERNATIONS[0]}}`;
    for (const locale of LOCALES) {
      const prefix = locale === "en" ? "" : `/${locale}`;
      expect(registered, `no country page route for ${locale}`).toContain(`${prefix}/${pattern}/`);
      expect(registered, `no geo.json route for ${locale}`).toContain(`${prefix}/${pattern}/geo.json`);
    }
    expect(registered).toHaveLength(LOCALES.length * 2);
  });

  it("every country URL the sitemaps publish is served by that route param", async () => {
    // The whole loop, end to end and with no hand-written URLs: the slug
    // comes from this table, the path from @givefood/urls (the same call
    // sitemaps.ts:40 and md.ts:77 make), and the router from index.ts. If any
    // of the three drifts, a crawler follows our own sitemap into a 404.
    const app = countryRouter();
    let checked = 0;
    for (const slug of Object.keys(COUNTRY_MAPPING)) {
      for (const locale of LOCALES) {
        for (const routeName of ["country", "country_geojson"]) {
          const path = urlForLocale(locale, routeName, slug);
          const res = await app.request(path);
          expect(res.status, `${routeName} publishes ${path} but the router rejects it`).toBe(200);
          // And the param the router hands back is a key this table owns, so
          // country.ts:25's COUNTRY_MAPPING[countrySlug] cannot miss.
          expect(Object.hasOwn(COUNTRY_MAPPING, await res.text())).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(DJANGO_SLUG_COUNT * LOCALES.length * 2);
  });

  it("route param refuses every other slug, prototype keys included", () => {
    // The converse of the test above, and the guarantee the plain-object
    // test leans on: the route param is the only thing standing between
    // `COUNTRY_MAPPING[c.req.param("countrySlug")]` and an inherited
    // Object.prototype member. Case matters too -- the table is
    // case-sensitive, so a router that matched /Scotland/ would reach
    // country.ts's defensive c.notFound() rather than the page.
    const app = countryRouter();
    const rejected = ["ireland", "isle-of-man", "jersey", "britain", "Scotland", "SCOTLAND", "constructor", "toString", "__proto__", "valueOf"];
    return Promise.all(
      rejected.map(async (slug) => {
        expect((await app.request(`/${slug}/`)).status, `/${slug}/ should not route`).toBe(404);
        expect((await app.request(`/cy/${slug}/`)).status, `/cy/${slug}/ should not route`).toBe(404);
      }),
    );
  });
});

describe("COUNTRY_MAP_CONFIG", () => {
  it("is Django's COUNTRY_MAP_CONFIG, centre and zoom exactly", () => {
    // givefood/views.py:44-65. These are hand-chosen map centres ("Chosen to
    // center the map on the geographical center of each country"), so there
    // is no formula to re-derive them from -- the only defence against a
    // stray edit is the literal comparison. toStrictEqual so that a
    // half-written fifth entry (`Jersey: undefined`) cannot hide inside it.
    expect(COUNTRY_MAP_CONFIG).toStrictEqual(DJANGO_COUNTRY_MAP_CONFIG);
  });

  it("is keyed by display name, not by slug", () => {
    // The module comment calls this out as matching the Python source's own
    // keying. country.ts:58 looks it up with `COUNTRY_MAP_CONFIG[countryName]!`
    // -- a non-null assertion -- so if this were ever re-keyed by slug to
    // "match" COUNTRY_MAPPING, every country page would 500 on `.lat` of
    // undefined rather than fail a type check.
    expect(COUNTRY_MAP_CONFIG["scotland"]).toBeUndefined();
    expect(COUNTRY_MAP_CONFIG["northern-ireland"]).toBeUndefined();
    expect(COUNTRY_MAP_CONFIG["Northern Ireland"]).toEqual({ lat: 54.6, lng: -6.5, zoom: 7 });
  });

  it("has an entry for every name COUNTRY_MAPPING can resolve to", () => {
    // The invariant behind country.ts:58's `!`. Asserted by walking the same
    // path the handler does -- slug in, settings out -- so it fails for the
    // same reason the handler would.
    for (const slug of Object.keys(COUNTRY_MAPPING)) {
      const countryName = COUNTRY_MAPPING[slug]!;
      expect(COUNTRY_MAP_CONFIG[countryName], `no map settings for ${countryName}`).toBeDefined();
    }
    // Both key sets compared against the hand-copied Django names rather than
    // against each other: two exports of one module agreeing proves nothing
    // if the same edit broke both.
    expect(Object.keys(COUNTRY_MAP_CONFIG).sort()).toEqual(DJANGO_COUNTRY_NAMES);
    expect(Object.values(COUNTRY_MAPPING).sort()).toEqual(DJANGO_COUNTRY_NAMES);
  });

  it("carries exactly the three fields CountryMapSettings declares", () => {
    // country.ts:59-66 copies lat/lng/zoom into the JSON blob the map JS
    // reads. An extra field added here would be silently dropped there
    // rather than reaching the map, so the shape is part of the contract.
    for (const [countryName, settings] of Object.entries(COUNTRY_MAP_CONFIG)) {
      const typed: CountryMapSettings = settings;
      expect(Object.keys(typed).sort(), `unexpected shape for ${countryName}`).toEqual(["lat", "lng", "zoom"]);
    }
    expect(Object.keys(COUNTRY_MAP_CONFIG)).toHaveLength(DJANGO_SLUG_COUNT);
  });

  it("holds numbers that survive the trip into window.gfMapConfig", () => {
    // country.ts:59 JSON.stringify()s these three values and mapconfig.njk
    // drops the result into a `<script>` with `|safe`. That path is lossy in
    // exactly one direction: NaN and Infinity serialise to `null`, so a
    // botched arithmetic edit reaches the browser as `{"lat":null}` and the
    // map silently renders centred on nothing. A numeric string survives
    // instead as `"6"`, which maplibre will not accept as a zoom.
    for (const [countryName, settings] of Object.entries(COUNTRY_MAP_CONFIG)) {
      expect(Number.isFinite(settings.lat), `${countryName} lat`).toBe(true);
      expect(Number.isFinite(settings.lng), `${countryName} lng`).toBe(true);
      expect(Number.isInteger(settings.zoom), `${countryName} zoom`).toBe(true);
      // maplibre-gl's own zoom range is 0-22; a slipped digit (60 for 6)
      // passes every check above and none of them below.
      expect(settings.zoom).toBeGreaterThanOrEqual(0);
      expect(settings.zoom).toBeLessThanOrEqual(22);
      expect(JSON.stringify(settings), `${countryName} does not round-trip`).not.toContain("null");
      expect(JSON.parse(JSON.stringify(settings))).toStrictEqual(settings);
    }
    expect(Object.keys(COUNTRY_MAP_CONFIG)).toHaveLength(DJANGO_SLUG_COUNT);
  });

  it("centres every country inside the British Isles", () => {
    // The classic edit that type-checks and reviews cleanly: lat and lng
    // transposed. Scotland's real centre is 57.7, -4; swapped it becomes
    // -4, 57.7 -- the Indian Ocean, on a page that still renders fine. This
    // bounding box (roughly Lizard Point to Shetland, Belfast to Lowestoft)
    // catches that, and any decimal-point slip, without pretending to
    // second-guess the chosen centres.
    for (const [countryName, settings] of Object.entries(COUNTRY_MAP_CONFIG)) {
      expect(settings.lat, `${countryName} latitude`).toBeGreaterThan(49);
      expect(settings.lat, `${countryName} latitude`).toBeLessThan(61);
      expect(settings.lng, `${countryName} longitude`).toBeGreaterThan(-8);
      expect(settings.lng, `${countryName} longitude`).toBeLessThan(2);
      // Every one of the four is west of Greenwich, and a swap would make
      // this the failing line even inside the box above.
      expect(settings.lng, `${countryName} longitude`).toBeLessThan(settings.lat);
    }
    expect(Object.keys(COUNTRY_MAP_CONFIG)).toHaveLength(DJANGO_SLUG_COUNT);
  });
});

// Shape of every example, with the postcode and the town captured: "e.g.
// EH12 5PJ or Glasgow". Used twice below -- once to check the string a
// visitor sees, once to check the postcode survives translation.
const EXAMPLE_SHAPE = /^e\.g\. ([A-Z]{1,2}\d{1,2}[A-Z]? \d[A-Z]{2}) or ([A-Z][a-z]+)$/;

describe("COUNTRY_PLACEHOLDERS", () => {
  it("is Django's COUNTRY_PLACEHOLDERS, msgid for msgid", () => {
    // givefood/views.py:68-73 with the `_()` wrapper unwrapped. Byte
    // equality matters more here than elsewhere in this file: these strings
    // are not shown, they are looked up (see the catalogue test below), so a
    // single changed character is a permanent silent fallback to English.
    expect(COUNTRY_PLACEHOLDERS).toStrictEqual(DJANGO_COUNTRY_PLACEHOLDERS);
  });

  it("is keyed by display name, sharing COUNTRY_MAP_CONFIG's key set", () => {
    // country.ts:85 indexes it with `countryName`, the same value it used
    // for COUNTRY_MAP_CONFIG a few lines earlier. A miss here is quieter
    // than a missing map config -- `placeholder` becomes undefined, the njk
    // `{{ _(placeholder) }}` renders empty, and the search box simply loses
    // its example. Nothing errors, so only a test catches it.
    expect(Object.keys(COUNTRY_PLACEHOLDERS).sort()).toEqual(DJANGO_COUNTRY_NAMES);
    for (const slug of Object.keys(COUNTRY_MAPPING)) {
      expect(COUNTRY_PLACEHOLDERS[COUNTRY_MAPPING[slug]!], `no placeholder for /${slug}/`).toBeTruthy();
    }
    expect(COUNTRY_PLACEHOLDERS["wales"]).toBeUndefined();
  });

  it("offers a distinct example per country that this site would accept", () => {
    // Shape, not wording: "e.g. <outward> <inward> or <town>". public/
    // country.njk:45 drops the string straight into the input's placeholder
    // attribute, so it is the only instruction a visitor gets about what to
    // type -- an example that is not a parseable postcode teaches the wrong
    // format. "Parseable" is not this test's own opinion: the example is run
    // through parseAdminFields, whose POSTCODE_REGEX is the port of Django's
    // one postcode validator (givefood/models/base.py:63-69) and the only
    // definition of a valid postcode the codebase has. Distinctness catches
    // the copy-paste slip of giving two countries the same example.
    const values = Object.values(COUNTRY_PLACEHOLDERS);
    expect(values).toHaveLength(DJANGO_SLUG_COUNT);
    for (const value of values) {
      const match = EXAMPLE_SHAPE.exec(value);
      expect(match, `malformed example: ${value}`).not.toBeNull();
      const parsed = parseAdminFields(fieldsByName(["postcode"]), { postcode: match![1]! });
      expect(parsed.ok, `${match![1]} is not a postcode this site would accept`).toBe(true);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it("stores msgids that every shipped catalogue can still translate", () => {
    // This is the whole point of the module comment's "NOT translated here".
    // The string travels untranslated through country.ts:85 into
    // country.njk:45's `{{ _(placeholder) }}`, where i18n.ts's translate()
    // looks it up. translate() falls back to the msgid on a miss, so a
    // reworded placeholder does not break the page -- it silently serves the
    // English example to every Welsh, Irish and Gaelic visitor, forever, and
    // nothing anywhere reports it. Locales come from LOCALES rather than a
    // hand-written list, so a fifth language shipped without these four
    // msgids fails here instead of quietly falling back.
    const translatable = LOCALES.filter((locale) => locale !== "en");
    expect(translatable.length, "no non-English locales left to check").toBeGreaterThan(0);
    return Promise.all(
      translatable.map(async (locale) => {
        const catalogue = await loadCatalogue(locale);
        for (const msgid of Object.values(COUNTRY_PLACEHOLDERS)) {
          const translated = translate(catalogue, msgid);
          expect(translated, `${locale} has no translation for "${msgid}"`).not.toBe(msgid);
          expect(translated.length).toBeGreaterThan(0);
          // The town is localised (cy renders Manchester as "Fanceinion"),
          // the postcode never is -- a Welsh visitor still has to type a real
          // UK postcode, and this string is the only place the format is
          // shown. A translation that dropped or "localised" it would still
          // pass every assertion above while teaching nonsense.
          const postcode = EXAMPLE_SHAPE.exec(msgid)![1]!;
          expect(translated, `${locale} lost the postcode from "${msgid}"`).toContain(postcode);
          // translate() interpolates %(name)s from its vars and country.njk
          // passes none, so any Python format token a translator pasted in
          // would silently blank out (or, for a bare %s, render literally).
          expect(translated, `${locale} has a stray format token`).not.toContain("%");
        }
      }),
    );
  });

  it("passes through untouched on English, where there is no catalogue", () => {
    // loadCatalogue("en") returns {} by design (i18n.ts:25), so the English
    // page renders the msgid itself. That is the intended path, not a
    // fallback, and it is why the msgids have to read as finished English
    // copy rather than as keys like "country_placeholder_scotland".
    return loadCatalogue("en").then((catalogue) => {
      expect(catalogue).toStrictEqual({});
      for (const msgid of Object.values(COUNTRY_PLACEHOLDERS)) {
        expect(translate(catalogue, msgid)).toBe(msgid);
      }
    });
  });
});
