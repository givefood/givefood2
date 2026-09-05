import type { Context } from "hono";
import {
  getAllConstituenciesOrderedByName,
  getConstituencyBySlugNarrow,
  getFoodbanksByIds,
  getFoodbanksForConstituency,
  getNeedTranslationsByIds,
  type ConstituencyListRow,
  type FoodbankWithLatestNeed,
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
    const slug = await constituencySlugFromPostcode(postcode);
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

// api.postcodes.io -- free, keyless UK postcode lookup. Prefers the 2024
// boundary review's constituency name (parliamentary_constituency_2024)
// over the pre-2024 one, falling back to it only when the 2024 field is
// absent, matching Django's exact preference order.
export async function constituencySlugFromPostcode(postcode: string): Promise<string | null> {
  const response = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}?decache=true`);
  if (!response.ok) return null;
  const json = (await response.json()) as { result?: { parliamentary_constituency_2024?: string | null; parliamentary_constituency?: string | null } };
  const name = json.result?.parliamentary_constituency_2024 || json.result?.parliamentary_constituency;
  return name ? slugifyConstituencyName(name) : null;
}

// Django's slugify() on the constituency name -- NFKD-normalise then drop
// combining marks BEFORE stripping non-alphanumerics (Python's real
// django.utils.text.slugify does the same, via unicodedata.normalize
// ("NFKD", value).encode("ascii", "ignore")), not just discarding
// non-ASCII outright -- of the 650 real 2024 constituency names, two need
// this ("Ynys Môn" -> "ynys-mon", "Montgomeryshire and Glyndŵr" ->
// "montgomeryshire-and-glyndwr"), verified directly against a real Django
// install. @givefood/models' own slugify() does NOT do this either (it
// treats non-ASCII as noise to hyphenate, not transliterate) -- not reused
// here since it would be equally wrong for this specific need, and fixing
// that shared, more-widely-relied-on function is a separate decision.
function slugifyConstituencyName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-");
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
