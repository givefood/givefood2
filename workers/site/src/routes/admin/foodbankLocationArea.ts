import type { Context } from "hono";
import { getFoodbankBySlug, upsertLocation } from "@givefood/db";
import { render } from "@givefood/templates";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { verifyCsrf } from "../../lib/csrf";
import { adminPageContext } from "./pageContext";

const MAPIT_TIMEOUT_MS = 20_000;

// givefood/forms.py:168 `name = forms.CharField(max_length=100, ...)` --
// same NAME_MAX_LENGTH guard and message as items.ts/orderGroup.ts.
const NAME_MAX_LENGTH = 100;

interface MapItGeometry {
  centre_lat?: number;
  centre_lon?: number;
}

// gfadmin/views.py:1647-1725 fblocation_area_form -- creates a
// FoodbankLocation from a MapIt administrative area's centroid + boundary
// instead of a postcode, for locations that cover a whole area (a
// district, a ward) rather than a single address. PLAN.md's own pre-build
// research (§9672) singles this out as "the template for how every other
// form should report failure" -- six distinct, individually-reported
// error paths, ported one for one rather than collapsed into a generic
// "something went wrong". Reuses upsertLocation (WP 6.5) directly:
// address/postcode are already nullable there, country/foodbank_* already
// default from the parent foodbank, boundary_geojson is already a plain
// column -- this is a new caller of existing machinery, not new machinery.
export async function adminFoodbankLocationAreaForm(c: Context<AppEnv>): Promise<Response> {
  const db = dbSession(c);
  const foodbank = await getFoodbankBySlug(db, c.req.param("slug")!);
  if (!foodbank) return c.notFound();

  let name = "";
  let mapitId = "";
  let error: string | undefined;

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const csrfToken = typeof body.csrf_token === "string" ? body.csrf_token : undefined;
    if (!(await verifyCsrf(c, c.env.CSRF_SECRET, csrfToken))) return c.text("Forbidden", 403);

    name = typeof body.name === "string" ? body.name.trim() : "";
    mapitId = typeof body.mapit_id === "string" ? body.mapit_id.trim() : "";
    const mapitIdNum = Number(mapitId);

    if (!name) {
      error = "Name is required";
    } else if (name.length > NAME_MAX_LENGTH) {
      error = `Name must be ${NAME_MAX_LENGTH} characters or fewer`;
    } else if (!mapitId || !Number.isInteger(mapitIdNum)) {
      // forms.py:169 `mapit_id = forms.IntegerField(...)` has no min_value,
      // so Django itself accepts 0 or a negative id and lets the MapIt
      // fetch below fail with a real "Failed to fetch geometry" error --
      // rejecting <= 0 here up front would show a different, wrong error
      // for a case Django would happily forward to the API.
      error = "MapIt Area ID is required and must be a whole number";
    } else {
      const result = await fetchMapItArea(c.env.MAPIT_KEY, mapitIdNum);
      if (!result.ok) {
        error = result.error;
      } else {
        await upsertLocation(
          db,
          {
            foodbankId: foodbank.id,
            foodbank: { name: foodbank.name, slug: foodbank.slug, network: foodbank.network, phone_number: foodbank.phone_number, contact_email: foodbank.contact_email, country: foodbank.country },
            name,
            address: null,
            postcode: null,
            isDonationPoint: 0,
            isMobile: 0,
            latLng: result.latLng,
            boundaryGeojson: result.boundaryGeojson,
            placeId: null,
            phoneNumber: null,
            email: null,
          },
          undefined,
        );
        return c.redirect(`/admin/foodbank/${foodbank.slug}/`, 302);
      }
    }
  }

  const html = await render("admin/foodbank_location_area_form.njk", {
    ...(await adminPageContext(c, "foodbanks")),
    title: `New ${foodbank.name} Food Bank Location from MapIt Area`,
    foodbank,
    name,
    mapit_id: mapitId,
    error,
  });
  return c.html(html);
}

type MapItResult = { ok: true; latLng: string; boundaryGeojson: string } | { ok: false; error: string };

async function fetchMapItArea(apiKey: string, mapitId: number): Promise<MapItResult> {
  try {
    const geometryRes = await fetch(`https://mapit.mysociety.org/area/${mapitId}/geometry?api_key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(MAPIT_TIMEOUT_MS),
    });
    if (!geometryRes.ok) return { ok: false, error: `Failed to fetch geometry from MapIt API (status ${geometryRes.status})` };

    let geometry: MapItGeometry;
    try {
      geometry = await geometryRes.json();
    } catch {
      return { ok: false, error: "MapIt API returned invalid JSON for geometry" };
    }

    const geojsonRes = await fetch(`https://mapit.mysociety.org/area/${mapitId}.geojson?api_key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(MAPIT_TIMEOUT_MS),
    });
    if (!geojsonRes.ok) return { ok: false, error: `Failed to fetch geojson from MapIt API (status ${geojsonRes.status})` };

    let geojson: unknown;
    try {
      geojson = await geojsonRes.json();
    } catch {
      return { ok: false, error: "MapIt API returned invalid JSON for geojson" };
    }

    if (geometry.centre_lat === undefined || geometry.centre_lon === undefined || geometry.centre_lat === null || geometry.centre_lon === null) {
      return { ok: false, error: "MapIt API did not return centre coordinates" };
    }

    return {
      ok: true,
      latLng: `${geometry.centre_lat},${geometry.centre_lon}`,
      boundaryGeojson: JSON.stringify({ type: "Feature", geometry: geojson }),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return { ok: false, error: "Request to MapIt API timed out" };
    return { ok: false, error: `Error calling MapIt API: ${err instanceof Error ? err.message : String(err)}` };
  }
}
