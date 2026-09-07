import type { Context } from "hono";
import { getFoodbankBySlug, upsertLocation, locationNameTaken, locationSlugTaken, locationSlug } from "@givefood/db";
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
    } else if (await locationNameTaken(db, foodbank.id, name, undefined)) {
      // loc_fb_name_uniq, the same UNIQUE(foodbank_id, name) index behind
      // issue #12 -- reached here typically by adding the boundary version
      // of a location that already exists from the postcode form, or by a
      // browser retrying a slow POST (the button's `this.disabled = true`
      // guard does not survive a back-button re-post).
      //
      // HONEST NOTE ON PARITY: Django 500s here too. FoodbankLocationAreaForm
      // (givefood/forms.py:167-170) is a plain forms.Form, not a ModelForm,
      // so no validate_unique() ever ran and views.py:1717-1723's
      // `.save()` raised IntegrityError. This is an improvement on Django,
      // not a restoration of it -- but the message is still Django's own
      // unique_together wording for this model, because that is what the
      // OTHER location form reported for the identical clash and one
      // constraint should not speak with two voices.
      //
      // Placed BEFORE the MapIt calls below deliberately: they are two
      // sequential fetches with a 20s timeout each, and burning 40s to
      // arrive at a refusal we could have made from a single indexed SELECT
      // is most of what made the 500 here expensive.
      //
      // `undefined` as exceptId, spelled out rather than threaded: this
      // route is registered create-only (routes/admin/index.ts:154-155) and
      // passes `undefined` to upsertLocation unconditionally, so there is
      // never a row to exclude.
      error = `Foodbank location with this Foodbank and Name already exists: "${name}"`;
    } else if (await locationSlugTaken(db, foodbank.id, locationSlug(name), undefined)) {
      // See locationSlugTaken's own comment: not a UNIQUE index, so no 500
      // to prevent, but a second row on a slug that is already taken is
      // shadowed by getFoodbankLocationBySlugs' `.first()` and is
      // unreachable from the moment it is written.
      error = `Another location at this food bank already uses the URL "${locationSlug(name)}", which is derived from the name -- two names differing only in punctuation produce the same one`;
    } else {
      const result = await fetchMapItArea(c.env.MAPIT_KEY, mapitIdNum);
      if (!result.ok) {
        error = result.error;
      } else {
        // Backstop, not the guard -- locationNameTaken above is the guard.
        // What is left for this to catch is the gap between that SELECT and
        // this INSERT: the double-click this form's own submit button tries
        // to prevent, a browser retrying a slow POST after 40s of MapIt, and
        // above all a STALE READ -- lib/session.ts opens every request
        // "first-unconstrained" and this database has read replication
        // enabled (packages/db/src/types.ts:1-7), so the pre-flight can run
        // against a replica that has not yet seen an insert the primary
        // already holds. Without it those still reach app.onError and render
        // the 500 page over both typed fields, which is the loss issue #12
        // is about. Same backstop foodbank.ts and foodbankLocation.ts keep
        // around their own writes.
        try {
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
        } catch (err) {
          // The raw SQLite text goes to the log, not into the admin's page.
          console.error("location area save: upsert failed", err);
          error = "Could not save this location -- the database refused the change, so nothing was saved. Check the name is not already in use and try again.";
        }
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
