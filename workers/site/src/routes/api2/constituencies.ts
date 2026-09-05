import { Hono } from "hono";
import {
  getAllConstituencies,
  getConstituencyBySlug,
  getFoodbanksByIds,
  getFoodbanksForConstituency,
  type FoodbankChangeRow,
  type FoodbankWithLatestNeed,
} from "@givefood/db";
import type { SerialisableValue } from "@givefood/serialise";
import type { AppEnv } from "../../types";
import { url } from "@givefood/urls";
import { dbSession } from "../../lib/session";
import { apiResponse, SECONDS_IN_DAY, SECONDS_IN_WEEK } from "../../lib/apiResponse";
import { emailOrFoodbankEmail, phoneOrFoodbankPhone } from "@givefood/models";

// gfapi2 `constituencies` / `constituency` -- givefood/urls.py:
// /constituencies/, /constituency/<slug:slug>/. Ported straight from
// gfapi2/views.py, verbatim.
export const api2ConstituenciesApp = new Hono<AppEnv>();

// Every "self"/"html"/"map"/"url" URL below is a literal
// "https://www.givefood.org.uk" prefix, not derived from the request (see
// task point 12) -- reproduced as a hardcoded string here.
const SITE_DOMAIN = "https://www.givefood.org.uk";

// The shape `ParliamentaryConstituency.foodbanks()` builds per entry --
// one dict per open food bank in the constituency, concatenated with one
// dict per open location in the constituency (frozen bug B3: neither list
// is merged or sorted, and a location entry's `slug` gets reused below to
// build a `/api/2/foodbank/<slug>/` URL that 404s -- do not "fix" that).
interface ConstituencyFoodbankEntry {
  type: "organisation" | "location";
  name: string;
  slug: string;
  lat_lng: string;
  // The food bank's own latest_need (organisation entries) or the PARENT
  // food bank's latest_need (location entries). Dereferenced unguarded
  // below (`.change_text` etc.), matching the real view -- see B12
  // (PLAN.md §7.3): a food bank with no latest_need 500s here, and that
  // crash is reproduced, not masked.
  needs: FoodbankChangeRow | null;
  url: string;
  shopping_list_url: string;
  gf_url: string;
  phone_number: string | null;
  contact_email: string | null;
  facebook_page: string | null;
}

// `ParliamentaryConstituency.foodbanks()` -- builds the organisation-entry
// list and the location-entry list, then concatenates them in that order
// (foodbanks first, locations second), unsorted.
async function buildConstituencyFoodbankEntries(
  session: ReturnType<typeof dbSession>,
  constituencyId: number,
): Promise<ConstituencyFoodbankEntry[]> {
  const { foodbanks, locations } = await getFoodbanksForConstituency(session, constituencyId);

  // One getFoodbanksByIds call covering BOTH the organisation entries' own
  // ids and the location entries' parent-food-bank ids, instead of two
  // sequential calls -- found via real timing comparisons against
  // production (a WP 2.5 follow-up): this endpoint was ~3.5x slower than
  // Django's, and the two back-to-back id-batch fetches were most of it.
  const allIds = [...new Set([...foodbanks.map((fb) => fb.id), ...locations.map((loc) => loc.foodbank_id)])];
  const foodbanksWithNeed = await getFoodbanksByIds(session, allIds);
  const foodbankById = new Map<number, FoodbankWithLatestNeed>(foodbanksWithNeed.map((fb) => [fb.id, fb]));

  const organisationEntries: ConstituencyFoodbankEntry[] = foodbanks.map((fb) => {
    const withNeed = foodbankById.get(fb.id) as FoodbankWithLatestNeed;
    return {
      type: "organisation",
      name: fb.name,
      slug: fb.slug,
      lat_lng: fb.lat_lng,
      needs: withNeed.latestNeed,
      url: fb.url,
      shopping_list_url: fb.shopping_list_url,
      gf_url: url("wfbn:foodbank", fb.slug),
      phone_number: fb.phone_number,
      contact_email: fb.contact_email,
      facebook_page: fb.facebook_page,
    };
  });

  const locationEntries: ConstituencyFoodbankEntry[] = locations.map((loc) => {
    // A location's `foodbank_id` FK is trusted to resolve, matching the
    // Django source's unguarded `location.foodbank` access.
    const parent = foodbankById.get(loc.foodbank_id) as FoodbankWithLatestNeed;
    return {
      type: "location",
      name: loc.name,
      slug: loc.slug,
      lat_lng: loc.lat_lng,
      needs: parent.latestNeed,
      url: parent.url,
      shopping_list_url: parent.shopping_list_url,
      gf_url: url("wfbn:foodbank_location", loc.foodbank_slug, loc.slug),
      phone_number: phoneOrFoodbankPhone(loc.phone_number, parent.phone_number),
      contact_email: emailOrFoodbankEmail(loc.email, parent.contact_email),
      facebook_page: parent.facebook_page,
    };
  });

  return organisationEntries.concat(locationEntries);
}

// Django's geojson_dict() strips one trailing comma before parsing, if
// present -- reproduced defensively here.
function parseBoundaryGeojson(raw: string): SerialisableValue {
  const trimmed = raw.trim();
  const cleaned = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
  return JSON.parse(cleaned) as SerialisableValue;
}

// --- constituencies (GET /constituencies/) --------------------------------
api2ConstituenciesApp.get("/constituencies/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const session = dbSession(c);

  // Deliberately unordered -- ParliamentaryConstituency.objects.all() with
  // no .order_by(), see getAllConstituencies's own comment. Do not sort.
  const constituencies = await getAllConstituencies(session);

  const responseList = constituencies.map((constituency) => ({
    name: constituency.name,
    slug: constituency.slug,
    country: constituency.country,
    urls: {
      self: `${SITE_DOMAIN}/api/2/constituency/${constituency.slug}/`,
      html: `${SITE_DOMAIN}/needs/in/constituency/${constituency.slug}/`,
    },
  }));

  return apiResponse(responseList, "constituencies", format, SECONDS_IN_DAY);
});

// --- constituency (GET /constituency/<slug:slug>/) ------------------------
api2ConstituenciesApp.get("/constituency/:slug/", async (c) => {
  const format = c.req.query("format") ?? "json";
  const slug = c.req.param("slug");
  const session = dbSession(c);

  const constituency = await getConstituencyBySlug(session, slug);
  if (!constituency) return c.notFound();

  const entries = await buildConstituencyFoodbankEntries(session, constituency.id);

  let responseDict: SerialisableValue;
  if (format !== "geojson") {
    const foodbankList: SerialisableValue[] = entries.map((entry) => {
      const need = entry.needs as FoodbankChangeRow; // unguarded, see ConstituencyFoodbankEntry's comment
      return {
        name: entry.name,
        slug: entry.slug,
        lat_lng: entry.lat_lng,
        needs: need.change_text,
        excess: need.excess_change_text,
        urls: {
          self: `${SITE_DOMAIN}/api/2/foodbank/${entry.slug}/`,
          html: `${SITE_DOMAIN}/needs/at/${entry.slug}/`,
          homepage: entry.url,
          shopping_list: entry.shopping_list_url,
          map: `${SITE_DOMAIN}/needs/at/${entry.slug}/map.png`,
        },
      };
    });
    responseDict = { name: constituency.name, slug: constituency.slug, foodbanks: foodbankList };
  } else {
    const features: SerialisableValue[] = entries.map((entry) => {
      const need = entry.needs as FoodbankChangeRow; // unguarded, see ConstituencyFoodbankEntry's comment
      const parts = entry.lat_lng.split(",");
      const lat = parts[0] as string;
      const lng = parts[1] as string;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [parseFloat(lng), parseFloat(lat)] },
        properties: {
          name: entry.name,
          slug: entry.slug,
          needs: need.change_text,
          excess: need.excess_change_text,
          url: `${SITE_DOMAIN}${entry.gf_url}`,
        },
      };
    });
    // The constituency's own boundary, appended as the raw parsed GeoJSON
    // geometry object -- NOT wrapped in {"type":"Feature",...}, pushed
    // directly into the features array as-is, matching the source.
    features.push(parseBoundaryGeojson(constituency.boundary_geojson ?? ""));
    responseDict = { type: "FeatureCollection", features };
  }

  return apiResponse(responseDict, "constituency", format, SECONDS_IN_WEEK);
});
