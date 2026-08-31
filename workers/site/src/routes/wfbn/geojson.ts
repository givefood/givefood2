import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { dbSession } from "../../lib/session";
import { buildGeojsonResponse } from "../../lib/buildGeojson";

// gfwfbn `geojson` (GET /needs/geo.json, /needs/at/<slug>/geo.json,
// /needs/at/<slug>/<locslug>/geo.json, /needs/in/constituency/<slug>/geo.json
// -- all four i18n-patterned, gfwfbn/urls/i18n.py). One Django view
// (gfwfbn/views.py:207-339) handles all four URL patterns by which kwargs
// are present; split into four thin handlers here since each is a
// distinct Hono route (see buildGeojson.ts for the shared logic, ported
// from that single view).
//
// `Content-Type: application/json` set explicitly, same convention as
// apiResponse.ts. `Cache-Control` is `max-age=<one week>` ONLY -- not
// apiResponse.ts's `public, max-age=X, s-maxage=X` (that's this codebase's
// own convention for gfapi2, not what Django emits here): the real
// `@cache_page(SECONDS_IN_WEEK)` on this view calls `patch_response_headers`,
// which sets bare `max-age`, no `public`/`s-maxage` -- confirmed against
// the live site's response headers directly.
const SECONDS_IN_WEEK = 604800;

function jsonResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${SECONDS_IN_WEEK}`,
    },
  });
}

export async function wfbnGeojson(c: Context<AppEnv>): Promise<Response> {
  const locale = c.get("lang");
  const session = dbSession(c);
  const body = await buildGeojsonResponse(session, locale, { kind: "all" });
  // Never null for this scope -- buildGeojsonResponse only returns null
  // for the slug/locslug/constituency lookups, none of which apply here.
  return jsonResponse(body as string);
}

export async function wfbnFoodbankGeojson(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const locale = c.get("lang");
  const session = dbSession(c);
  const body = await buildGeojsonResponse(session, locale, { kind: "foodbank", slug });
  if (body === null) return c.notFound();
  return jsonResponse(body);
}

export async function wfbnFoodbankLocationGeojson(c: Context<AppEnv>): Promise<Response> {
  const slug = c.req.param("slug")!;
  const locslug = c.req.param("locslug")!;
  const locale = c.get("lang");
  const session = dbSession(c);
  const body = await buildGeojsonResponse(session, locale, { kind: "location", slug, locslug });
  if (body === null) return c.notFound();
  return jsonResponse(body);
}

export async function wfbnConstituencyGeojson(c: Context<AppEnv>): Promise<Response> {
  const parlconSlug = c.req.param("parlconSlug")!;
  const locale = c.get("lang");
  const session = dbSession(c);
  const body = await buildGeojsonResponse(session, locale, { kind: "constituency", parlconSlug });
  if (body === null) return c.notFound();
  return jsonResponse(body);
}
