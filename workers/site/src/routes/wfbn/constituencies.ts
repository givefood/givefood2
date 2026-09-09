import type { Context } from "hono";
import {
  getAllConstituenciesOrderedByName,
  getConstituencyBySlugNarrow,
  getConstituencySlugByPcon24cd,
  getFoodbanksByIds,
  getFoodbanksForConstituency,
  getNeedTranslationsByIds,
  type ConstituencyListRow,
  type FoodbankWithLatestNeed,
  type Session,
} from "@givefood/db";
import { buildPageContext, render } from "@givefood/templates";
import { nearest, R_PYTHON } from "@givefood/geo";
import { url, urlForLocale } from "@givefood/urls";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { elapsedMs } from "../../middleware/serverTiming";
import { emailOrFoodbankEmail, ENABLE_WRITE, fullNameLocaleAware, phoneOrFoodbankPhone, resolveNeedText } from "@givefood/models";
import { constituencySchemaOrgStr } from "../../lib/schemaOrg";

// gfwfbn `constituencies` (GET /needs/in/constituencies/, i18n-patterned).
// Ported from gfwfbn/views.py:1047-1066. Django's `postcode` GET param
// redirect calls admin_regions_from_postcode() -- a live api.postcodes.io
// lookup, no API key needed -- and on success 302s straight to the
// resolved constituency page rather than rendering this page at all; on
// failure (or an unrecognised postcode) it falls through to render the
// index with `postcode` still set, which the template uses to show a
// "didn't recognise this postcode" notice.
// SECONDS_IN_WEEK -- @cache_page(SECONDS_IN_WEEK) on both handlers below,
// reproduced as a bare max-age header, same "no public/s-maxage" convention
// as routes/wfbn/geojson.ts (confirmed against a live response there).
const CACHE_MAX_AGE_WEEK = "max-age=604800";

export async function wfbnConstituencies(c: Context<AppEnv>): Promise<Response> {
  const session = dbSession(c);
  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";
  const postcode = c.req.query("postcode") ?? null;

  if (postcode) {
    const slug = await constituencySlugFromPostcode(session, postcode);
    if (slug) {
      const target = urlForLocale(locale, "wfbn:constituency", slug);
      return c.redirect(target, 302);
    }
  }

  const constituencies = await getAllConstituenciesOrderedByName(session);
  // Django's `{% regroup constituencies|dictsort:"country" by country %}`
  // -- Nunjucks has no regroup tag, so group here. dictsort re-sorts by
  // country first (stable, so the existing name order survives within
  // each group); Map preserves first-insertion key order, matching
  // dictsort's own group order (alphabetical, since it's a straight sort).
  const byCountry = new Map<string, ConstituencyListRow[]>();
  for (const constituency of [...constituencies].sort((a, b) => (a.country ?? "").localeCompare(b.country ?? ""))) {
    const key = constituency.country ?? "";
    const group = byCountry.get(key);
    if (group) group.push(constituency);
    else byCountry.set(key, [constituency]);
  }
  const countryGroups = Array.from(byCountry.entries()).map(([country, items]) => ({ country, constituencies: items }));

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/constituency/index.njk",
    { ...context, render_time_ms: elapsedMs(c), postcode, country_groups: countryGroups },
    locale,
  );
  c.header("Cache-Control", CACHE_MAX_AGE_WEEK);
  return c.html(html);
}

// openpostcodes.uk -- free, keyless UK postcode lookup, replacing
// api.postcodes.io (github #56). Flat response, no `result` envelope, and
// the constituency arrives as `{ name, code }`.
//
// THE CODE, NOT THE NAME, AND THAT IS THE POINT OF THE MOVE. The old
// implementation took the constituency NAME and ran Django's slugify over
// it, then redirected to whatever that produced -- without checking such a
// page existed. That is the pattern PLAN.md §6.9 R7 warns about by name
// ("Do not reimplement slugify"), and swapping upstreams is exactly when it
// bites: our 650 slugs were derived from postcodes.io's spelling of these
// names, and a new provider that writes one of them differently -- an
// ampersand, an apostrophe, "and" versus "&" -- would 302 the visitor to a
// 404 with nothing logged. Verified before changing it: the old slugify
// agreed with all 650 stored slugs, so this was correct and undetectably
// fragile rather than already broken.
//
// `constituency.code` is the ONS PCON24CD, which
// 0011_constituency_pcon24cd.sql already stores on all 650 rows with none
// missing (read-only count against production D1). Spot-checked across all
// four nations: E14001460 Salisbury, W07000112 Ynys Mon, S14000078
// Edinburgh East and Musselburgh, N05000003 Belfast South and Mid Down --
// each resolving to the right slug. getConstituencySlugByPcon24cd is the
// helper migration 0011 was written for, already used for the map-click
// path in routes/write/index.ts:167 for this same reason; this is the
// second caller it was always meant to have.
//
// A CONSEQUENCE WORTH NAMING: the redirect target is now a row we have
// READ, so it cannot point at a page that does not exist. An unknown code
// returns null and falls through to the "didn't recognise this postcode"
// notice, which is where Django lands when postcodes.io returns nothing --
// the one input where the two differ is a constituency the API knows and we
// do not, which cannot happen while we hold all 650.
//
// Both non-2xx shapes this API uses are handled by the `ok` check: an
// unknown postcode is 404 {"error":"Postcode not found"}, a malformed one
// is 400 {"error":"Invalid postcode format"}.
export async function constituencySlugFromPostcode(session: Session, postcode: string): Promise<string | null> {
  const response = await fetch(`https://openpostcodes.uk/${encodeURIComponent(postcode)}.json`);
  if (!response.ok) return null;
  const json = (await response.json()) as { constituency?: { name?: string | null; code?: string | null } | null };
  const code = json.constituency?.code;
  return code ? getConstituencySlugByPcon24cd(session, code) : null;
}

// gfwfbn `constituency` (GET /needs/in/constituency/:slug/,
// i18n-patterned). Ported from gfwfbn/views.py:1069-1088.
export async function wfbnConstituency(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  // Neither call depends on the other's result (allConstituencies only
  // needs `session`) -- fetched together rather than the nearby-search
  // one waiting behind every other query below it.
  const [constituency, allConstituencies] = await Promise.all([
    getConstituencyBySlugNarrow(session, slug),
    getAllConstituenciesOrderedByName(session),
  ]);
  if (!constituency) return c.notFound();

  const locale = c.get("lang") as "en" | "cy" | "ga" | "gd";

  const { foodbanks: rawFoodbanks, locations } = await getFoodbanksForConstituency(session, constituency.id);
  // Every foodbank needing latest_need attached: the constituency's own
  // open food banks, PLUS every location's PARENT food bank (which can
  // differ from the constituency's own food-bank list -- a location can
  // sit in a different constituency than its parent's registered
  // address). One batched WHERE-IN, not N+1 (getFoodbanksByIds' own
  // reasoning), same as this file's other batched calls.
  const foodbankIds = Array.from(new Set([...rawFoodbanks.map((fb) => fb.id), ...locations.map((loc) => loc.foodbank_id)]));
  const foodbanksWithNeed = await getFoodbanksByIds(session, foodbankIds);
  const byId = new Map(foodbanksWithNeed.map((fb) => [fb.id, fb]));

  // FoodbankChangeTranslation batch lookup (needs.py:216-259) -- ONE D1
  // round trip covering every food bank on this page (constituency.html's
  // `foodbank.needs.get_change_text` is locale-aware; this table backs
  // that lookup). Django's real Nothing/Unknown/Facebook checks here
  // compare the ALREADY-TRANSLATED change_text (unlike foodbank.ts's own
  // page, which splits raw-for-the-gate vs translated-for-display -- see
  // that file's comment) -- constituency.njk's template already reads
  // `foodbank.get_change_text` for its checks, so no template change is
  // needed, only making this route's get_change_text translation-aware.
  const constituencyNeedIds = Array.from(
    new Set(foodbanksWithNeed.map((fb) => fb.latestNeed?.id).filter((id): id is number => id !== undefined && id !== null)),
  );
  const constituencyTranslations =
    locale !== "en" && constituencyNeedIds.length > 0 ? await getNeedTranslationsByIds(session, constituencyNeedIds, locale) : null;

  // ParliamentaryConstituency.foodbanks() (givefood/models/political.py:100-135)
  // -- concatenates the food-bank list then the location list, NEITHER
  // sub-list sorted (frozen bug B3, see getFoodbanksForConstituency's own
  // comment) -- reproduced here by not sorting either half.
  // `gf_url` below is deliberately the UNPREFIXED url() form, not
  // urlForLocale() -- preserving exactly what this page emitted before the
  // D7 consolidation moved the two path shapes into @givefood/urls.
  //
  // KNOWN DIVERGENCE, pre-existing and NOT introduced here: Django builds
  // this field with reverse() inside the request, which resolves under the
  // active language, so /cy/needs/in/constituency/<slug>/ links out to
  // /cy/needs/at/<slug>/ there and to /needs/at/<slug>/ here. Both names
  // are in I18N_SCOPED, so switching these two calls to urlForLocale()
  // would fix it in one line -- but that changes rendered output on every
  // non-English constituency page, which is a parity decision rather than
  // a refactor. Same bug class as the `human` entry in I18N_SCOPED's own
  // comment. constituency.njk:71 is the sole consumer.
  // "" (not "Nothing") when there's no latest_need at all -- Django's
  // `foodbank.needs` here is the raw nullable FK (not the
  // latest_need_text()-style sentinel wrapper foodbank.ts's own page
  // uses), so a None value resolves to Django's invalid-variable default
  // ('') and renders a blank cell, not the "isn't requesting anything"
  // message. See workers/site/src/routes/wfbn/foodbank.ts's own comment
  // for the general reasoning. Shared by both loops below (organisation
  // rows read `withNeed`, location rows read the parent's `parentFb` --
  // same FoodbankWithLatestNeed shape either way).
  const getChangeTextFor = (withNeed: FoodbankWithLatestNeed | undefined): string =>
    resolveNeedText(withNeed?.latestNeed?.change_text ?? "", withNeed?.latestNeed ? constituencyTranslations?.get(withNeed.latestNeed.id)?.change_text : undefined, locale);

  const combinedList: Array<Record<string, unknown>> = [];
  for (const fb of rawFoodbanks) {
    const withNeed = byId.get(fb.id);
    combinedList.push({
      type: "organisation",
      name: fb.name,
      gf_url: url("wfbn:foodbank", fb.slug),
      get_change_text: getChangeTextFor(withNeed),
      phone_number: fb.phone_number,
      contact_email: fb.contact_email,
      facebook_page: fb.facebook_page,
    });
  }
  for (const loc of locations) {
    const parentFb = byId.get(loc.foodbank_id);
    combinedList.push({
      type: "location",
      name: loc.name,
      foodbank_name: loc.foodbank_name,
      foodbank_name_slug: loc.foodbank_slug,
      gf_url: url("wfbn:foodbank_location", loc.foodbank_slug, loc.slug),
      get_change_text: getChangeTextFor(parentFb),
      phone_number: phoneOrFoodbankPhone(loc.phone_number, loc.foodbank_phone_number),
      contact_email: emailOrFoodbankEmail(loc.email, loc.foodbank_email),
      facebook_page: parentFb?.facebook_page ?? null,
    });
  }

  // ParliamentaryConstituency.nearby() = find_parlcons(centroid, 5, True)
  // -- an in-memory haversine over all ~650 constituencies (small enough
  // that the candidate-index/hydrate-later split the food-bank/location
  // search needs isn't warranted here; allConstituencies was already
  // fetched above, alongside the constituency lookup itself), R_PYTHON
  // matching Django's own distance_meters() (see
  // @givefood/geo/haversine.ts's own comment).
  const [centLatStr, centLngStr] = constituency.centroid.split(",");
  const centLat = Number(centLatStr);
  const centLng = Number(centLngStr);
  const nearbyRanked = nearest(
    allConstituencies,
    centLat,
    centLng,
    (item) => {
      const [lat, lng] = item.centroid.split(",");
      return [Number(lat), Number(lng)];
    },
    5,
    R_PYTHON,
    true,
  );
  const nearby = nearbyRanked.map((r) => r.item);

  const mapConfig = JSON.stringify({
    geojson: urlForLocale(locale, "wfbn:constituency_geojson", constituency.slug),
    max_zoom: 14,
  });

  const fullNamesByFoodbankId = new Map(
    Array.from(byId.values()).map((fb) => [fb.id, fullNameLocaleAware(fb.name, fb.alt_name, locale)]),
  );
  const schemaOrgFoodbanks = rawFoodbanks
    .map((fb) => byId.get(fb.id))
    .filter((fb): fb is FoodbankWithLatestNeed => fb !== undefined)
    .map((fb) => ({ foodbank: fb, fullName: fullNamesByFoodbankId.get(fb.id) ?? fb.name }));
  const schemaOrgLocations = locations
    .map((loc) => {
      const parentFb = byId.get(loc.foodbank_id);
      if (!parentFb) return null;
      const fullName = fullNamesByFoodbankId.get(parentFb.id) ?? parentFb.name;
      return { location: loc, foodbank: parentFb, fullName, locationFullName: `${loc.name}, ${fullName}` };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  const context = buildPageContext({
    path: c.req.path,
    pageTranslatable: true,
    locale,
    unprefixedPath: c.get("pathAfterPrefix"),
  });

  const html = await render(
    "wfbn/constituency/constituency.njk",
    {
      ...context,
      render_time_ms: elapsedMs(c),
      constituency: {
        ...constituency,
        latt: centLat,
        long: centLng,
        mp_photo_url: mpPhotoUrl(constituency.mp_parl_id),
        schema_org_str: constituencySchemaOrgStr(constituency, schemaOrgFoodbanks, schemaOrgLocations),
      },
      foodbanks: combinedList,
      nearby,
      map_config: mapConfig,
      enable_write: ENABLE_WRITE,
    },
    locale,
  );
  c.header("Cache-Control", CACHE_MAX_AGE_WEEK);
  return c.html(html);
}

// ParliamentaryConstituency.mp_photo_url() -- givefood/models/political.py:47-48.
export function mpPhotoUrl(mpParlId: number): string {
  return `https://photos.givefood.org.uk/2024-mp/${mpParlId}.jpg`;
}

// gfwfbn `mp_photo_redirect` (GET
// /needs/in/constituency/:slug/mp_photo_threefour.png, i18n-patterned).
// Ported from gfwfbn/views.py:1091-1097 -- no @cache_page in the real
// source either.
export async function wfbnMpPhotoRedirect(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const session = dbSession(c);
  const constituency = await getConstituencyBySlugNarrow(session, slug);
  if (!constituency) return c.notFound();
  return c.redirect(mpPhotoUrl(constituency.mp_parl_id), 302);
}
